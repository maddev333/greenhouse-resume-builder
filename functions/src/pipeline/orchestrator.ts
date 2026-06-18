/**
 * IngestCandidateOrchestrator - MVP Durable Functions orchestrator.
 *
 * Pipeline: fetch -> normalize -> section agents (parallel) -> dedup -> builder-agent -> persist
 */

import { app } from 'durable-functions';
import * as persist from '../persistence/index';

interface OrchestrationInput {
  runId:      string;
  tenantId?: string;
  requestedByUserId?: string;
  personOverride?: string;
  webUrls?:   string[];
  documentBlobs?: Array<{ name: string; mimeType?: string; data?: string }>;
}

interface PipelineResult {
  personId:       string;
  factsAdded:     number;
  experienceSegments: Array<{ employerName: string; jobTitle: string }>;
}

/**
 * Main orchestrator for the MVP ingestion pipeline.
 *
 * Durable Functions v3 orchestrators MUST be generator functions: every
 * activity call is `yield`-ed so the runtime can checkpoint/replay. The single
 * `context` argument carries the orchestration input via `context.df.getInput()`.
 */
export function* ingestCandidateOrchestrator(context: any): Generator<any, PipelineResult, any> {
  const df = context.df;
  const input = (df.getInput() ?? {}) as OrchestrationInput;
  const runId = input.runId;
  const tenantId = input.tenantId || 'tenant-default';
  const log = (msg: string) => { if (!df.isReplaying) context.log(msg); };

  log(`[Orchestrator] ▶ Starting ingestion run=${runId} tenant=${tenantId} webUrls=${input.webUrls?.length ?? 0}`);

  // Mark the run in_progress so the UI can reflect live status.
  yield df.callActivity('UpdateExtractionRunStatus', { runId, status: 'in_progress' });

  // ── Gate 1: Process uploads + fetch web sources ──
  const uploadResult = yield df.callActivity('StoreUploadsAndExtract', { runId, documentBlobs: input.documentBlobs });
  log(`[Orchestrator] Gate-1: uploads → ${uploadResult?.sourceDocs?.length ?? 0} source doc(s), ${uploadResult?.textBlocks?.length ?? 0} text block(s)`);
  const webUrlsFromDocs = (uploadResult?.sourceDocs || [])
    .filter((d: any) => d.uri && d.sourceType === 'web')
    .map((d: any) => d.uri);
  const webInputUrls = input.webUrls ?? [];
  const allWebUrls = [...new Set([...webUrlsFromDocs, ...webInputUrls.filter(Boolean)])];

  if (allWebUrls.length > 0) log(`[Orchestrator] Gate-1: fetching ${allWebUrls.length} web source(s): ${allWebUrls.join(', ')}`);
  const snapshotResults: any[] = allWebUrls.length > 0
    ? yield df.callActivity('FetchAndSnapshotWebSources', { runId, webUrls: allWebUrls })
    : [];
  if (allWebUrls.length > 0) log(`[Orchestrator] Gate-1: web fetch returned ${snapshotResults.length} snapshot(s)`);

  const normalizedTextBlocks: string[] = [...(uploadResult?.textBlocks ?? [])];
  if (snapshotResults.length > 0) {
    const snippets = snapshotResults.map((r: any) => r.contentSnippet).filter(Boolean);
    normalizedTextBlocks.push(...snippets);
  }

  // Fail loudly when input was provided but yielded no readable text, instead of silently
  // completing into an empty profile (which looks to the user like "nothing happened").
  if (normalizedTextBlocks.length === 0) {
    const uploadCount = input.documentBlobs?.length ?? 0;
    const reason = uploadCount > 0
      ? `No text could be extracted from the ${uploadCount} uploaded file(s). Text files (.txt, .md, .csv, .html, .json) are read directly; PDFs and images require Azure Document Intelligence — set AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT and sign in to Azure (az login / managed identity with the "Cognitive Services User" role) or set AZURE_DOCUMENT_INTELLIGENCE_KEY.`
      : (allWebUrls.length > 0
          ? `No content could be retrieved from the ${allWebUrls.length} web source(s).`
          : 'No sources were provided to ingest.');
    log(`[Orchestrator] \u2716 Aborting run ${runId}: ${reason}`);
    yield df.callActivity('UpdateExtractionRunStatus', { runId, status: 'failed', failedReason: reason });
    return { personId: '', factsAdded: 0, experienceSegments: [] };
  }

  const sectionTexts = normalizeSections(normalizedTextBlocks);
  log(`[Orchestrator] Gate-2: ${normalizedTextBlocks.length} text block(s) → sections experience:${sectionTexts.experience?.length ?? 0} skills:${sectionTexts.skills?.length ?? 0} education:${sectionTexts.education?.length ?? 0}`);

  // ── Gate 2A-C: Section agents in parallel (experience, skills, education) + full-text profile ──
  const sectionTasks = [
    df.callActivity('ExtractMvpExperienceSegment', { runId, textBlocks: sectionTexts.experience ?? [] }),
    df.callActivity('ProcessMvpSkillsSection', { runId, textBlocks: sectionTexts.skills ?? [] }),
    df.callActivity('ProcessEducationSection', { runId, textBlocks: sectionTexts.education ?? [] }),
    df.callActivity('ExtractProfile', { runId, textBlocks: normalizedTextBlocks }),
  ];
  const [experienceRaw, skillsRaw, educationRaw, profile] = yield df.Task.all(sectionTasks);

  // Merge the résumé-section results with anything the full-text profile pass found in prose,
  // so biographical pages (about/leadership/faculty bios) populate experience/skills/education too.
  const experienceResult = mergeExperience(experienceRaw || [], profile?.experience || []);
  const skillsList = mergeSkills(skillsRaw || [], profile?.skills || []);
  const educationResult = mergeEducation(educationRaw || [], profile?.education || []);
  log(`[Orchestrator] Gate-2: extracted ${experienceResult.length} experience, ${skillsList.length} skills, ${educationResult.length} education` +
      ` (profile pass added exp:${profile?.experience?.length ?? 0} skills:${profile?.skills?.length ?? 0} edu:${profile?.education?.length ?? 0})`);
  const profileExtraCount = (profile?.achievements?.length ?? 0) + (profile?.affiliations?.length ?? 0) + (profile?.links?.length ?? 0) +
      (profile?.headline ? 1 : 0) + (profile?.currentTitle ? 1 : 0) + (profile?.location ? 1 : 0);
  if (profileExtraCount > 0) log(`[Orchestrator] Gate-2: profile detail → headline:${profile?.headline ? 'y' : 'n'} role:${profile?.currentTitle ? 'y' : 'n'} location:${profile?.location ? 'y' : 'n'} achievements:${profile?.achievements?.length ?? 0} affiliations:${profile?.affiliations?.length ?? 0} links:${profile?.links?.length ?? 0}`);

  // ── Gate 3: Person dedup ──
  const nameMatch = (profile?.name && profile.name.trim()) || extractNameFromText(normalizedTextBlocks) || null;
  let personId = input.personOverride;
  let dedupStatus: 'system_matched' | 'recruiter_selected' | 'needs_review' =
    input.personOverride ? 'recruiter_selected' : 'needs_review';

  if (!personId) {
    const employers = (experienceResult || []).map((e: any) => normalizeEmployerName(e.employerName));
    log('[Orchestrator] Gate-3: Running dedup for ' + (nameMatch ?? 'unknown'));

    const dedupResult = yield df.callActivity('ResumeBuilderCandidateMatches', {
      extractionRunId: runId,
      extractedName: nameMatch ?? '',
      extractedEmployers: employers,
      existingCandidates: [],
    });

    if (dedupResult?.personId) {
      personId = dedupResult.personId;
      dedupStatus = 'system_matched';
    } else {
      personId = `person-${runId}`;
      dedupStatus = dedupResult?.isConfidentMatch ? 'system_matched' : 'needs_review';
    }
  }

  // ── Gate 4: Normalize extracted shapes for the builder agent ──
  log(`[Orchestrator] Gate-3: person resolved → ${personId} (${dedupStatus})`);
  const experienceSegs = (experienceResult || []) as Array<{
    employerName: string; jobTitle: string; startDate?: string; endDate?: string;
  }>;
  const skillsResults = (skillsList || []) as Array<{ name: string; proficiency?: string; evidence?: string }>;
  const eduResults = (educationResult || []) as Array<{
    schoolName: string; degree?: string; fieldOfStudy?: string; startDate?: string | null; endDate?: string | null; confidence?: number;
  }>;

  // ── Gate 4a: Summary generation (uses already-extracted data) ──
  let summaryPayload: any = null;
  try {
    const skItems = skillsResults.map((s: any) => ({ name: s.name || '', evidence: s.evidence }));
    summaryPayload = yield df.callActivity('ProcessSummarySection', {
      extract: experienceResult || [],
      skills: skItems,
      education: educationResult || [],
    });
    if (summaryPayload?.summary) log(`[Orchestrator] Gate-4a: summary generated (${summaryPayload.summary.length} chars)`);
  } catch (err: any) {
    log(`[Orchestrator] Summary generation failed (non-fatal): ${err?.message || err}`);
  }

  const sourceDocumentIds = (uploadResult?.sourceDocs ?? []).map((d: any) => d.id);

  // ── Gate 4b: Builder-agent stage (resume building) ──
  log(`[Orchestrator] Gate-4b: building resume (${experienceSegs.length} exp, ${skillsResults.length} skills, ${eduResults.length} edu)…`);
  const builderOutput = yield df.callActivity('ResumeBuilderAgent', {
    runId,
    tenantId,
    personId,
    sourceDocumentIds,
    extracted: {
      experience: experienceSegs,
      skills: skillsResults.map((s, i) => ({ name: s.name || `skill_${i}`, proficiency: s.proficiency, evidence: s.evidence })),
      education: eduResults,
    },
    summaryText: summaryPayload?.summary || profile?.summary,
    summaryMetadata: summaryPayload?.metadata,
    profile: profile ? {
      name: nameMatch,
      headline: profile.headline,
      currentTitle: profile.currentTitle,
      currentOrganization: profile.currentOrganization,
      location: profile.location,
      achievements: profile.achievements,
      affiliations: profile.affiliations,
      links: profile.links,
    } : undefined,
  });

  log(`[Orchestrator] Builder-agent complete - ${builderOutput.stats.factCount} facts, ${builderOutput.stats.bulletCount} bullets`);

  // ── Gate 5: Persist Person + builder output (all I/O inside the activity) ──
  const persistResult = yield df.callActivity('PersistBuilderOutput', {
    runId,
    person: {
      id: personId,
      tenantId,
      canonicalName: nameMatch || 'Unknown Candidate',
      aliases: nameMatch ? [nameMatch] : [],
      dedupStatus,
    },
    facts: builderOutput.facts,
    bullets: builderOutput.bullets,
  });
  log(`[Orchestrator] Gate-5 persisted ${persistResult?.factsPersisted ?? 0} facts + ${persistResult?.bulletsPersisted ?? 0} bullets, person=${persistResult?.personPersisted}`);

  // ── Gate 6: Relationship inference for matching persons (non-fatal) ──
  try {
    const employersForInference = experienceSegs.map(e => e.employerName).filter(Boolean);
    if (employersForInference.length > 0) {
      log(`[Orchestrator] Gate-6: inferring relationships from ${employersForInference.length} employer(s)`);
      yield df.callActivity('InferRelationshipsForMatchingPersons', {
        runId,
        personId,
        extractionRunId: runId,
      });
    }
  } catch (err: any) {
    log(`[Orchestrator] Relationship inference failed (non-fatal): ${err?.message || err}`);
  }

  // ── Mark run completed and record the resolved personId (drives UI nav) ──
  yield df.callActivity('UpdateExtractionRunStatus', { runId, status: 'completed', personId });

  log(`[Orchestrator] Pipeline complete for person ${personId}`);

  return {
    personId,
    factsAdded: builderOutput.stats.factCount,
    experienceSegments: experienceSegs,
  };
}

/** Heuristic section detection: split text blocks into section groups. */
function normalizeSections(chunks: string[]): Record<string, string[]> {
  const sections: Record<string, string[]> = {};
  let currentSection = 'experience'; // Default accumulation section

  for (const chunk of chunks) {
    const upper = chunk.toUpperCase().trim();

    if (/^(SKILLS|TECHNICAL SKILLS|TECHNICAL SKILLSET|TOOLS)/.test(upper))        currentSection = 'skills';
    else if (/^(EDUCATION|ACADEMIC|DEGREE|COURSEWORK|SCHOOL)/.test(upper)     ) currentSection = 'education';
    else if (/^(EXPERIENCE|WORK EXPERIENCE|EMPLOYMENT|PROFESSIONAL EXPERIENCE|HISTORY)/.test(upper)) {
      currentSection = 'experience';
    }

    // Accumulate under current section
    if (!sections[currentSection]) sections[currentSection] = [];
    sections[currentSection].push(chunk);
  }

  return sections;
}

/** Heading-like lines that pattern as 2+ capitalized words but are never a person's name. */
const NAME_HEADING_STOPWORDS = new Set([
  'curriculum vitae', 'resume', 'professional resume', 'profile', 'professional profile',
  'summary', 'professional summary', 'executive summary', 'career summary',
  'experience', 'work experience', 'professional experience', 'employment history',
  'education', 'academic background', 'skills', 'technical skills', 'core competencies',
  'contact', 'contact information', 'about', 'about me', 'objective', 'career objective',
  'biography', 'references', 'certifications', 'awards', 'publications', 'projects',
]);

/**
 * Extract a candidate name from résumé text using a line-aware heuristic.
 * Scans each line for a 2–4 word capitalized name, skipping common section
 * headings. Used only as a fallback when the model profile pass yields no name.
 */
function extractNameFromText(chunks: string[]): string | null {
  for (const chunk of chunks) {
    for (const rawLine of chunk.split(/\r?\n/)) {
      const line = rawLine.replace(/[*~_|]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (line.length < 3 || line.length > 60) continue;
      if (NAME_HEADING_STOPWORDS.has(line.toLowerCase())) continue;
      // 2–4 capitalized tokens (allow middle initials like "J." and name particles).
      if (/^[A-Z][a-zA-Z'\u2019-]+(?:\s+(?:[A-Z][a-zA-Z'\u2019-]+|[A-Z]\.|&|de|del|la|las|los|van|von|der|den|di|da|dos|du|bin|al|el))+$/.test(line)) {
        return line;
      }
    }
  }
  return null;
}

// ===== Helper normalization utilities =====

const normalizeEmployerName = (name: string): string => {
  return name.trim().toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ');
};

function normalizeString(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

// ===== Merge helpers: combine section-extractor output with the full-text profile pass =====
// Deterministic (pure) so they are safe to run inside the replayed orchestrator body.

function mergeExperience(
  base: Array<{ employerName: string; jobTitle?: string; startDate?: string | null; endDate?: string | null; location?: string | null }>,
  extra: Array<{ employerName: string; jobTitle?: string; startDate?: string | null; endDate?: string | null; location?: string | null }>,
): any[] {
  const seen = new Set(base.map(e => `${normalizeEmployerName(e.employerName || '')}|${normalizeString(e.jobTitle || '')}`));
  const merged = [...base];
  for (const e of extra) {
    if (!e?.employerName) continue;
    const key = `${normalizeEmployerName(e.employerName)}|${normalizeString(e.jobTitle || '')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(e);
  }
  return merged;
}

function mergeEducation(
  base: Array<{ schoolName: string; degree?: string }>,
  extra: Array<{ schoolName: string; degree?: string }>,
): any[] {
  const seen = new Set(base.map(e => `${normalizeString(e.schoolName || '')}|${normalizeString(e.degree || '')}`));
  const merged = [...base];
  for (const e of extra) {
    if (!e?.schoolName) continue;
    const key = `${normalizeString(e.schoolName)}|${normalizeString(e.degree || '')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(e);
  }
  return merged;
}

function mergeSkills(
  base: Array<{ name: string; proficiency?: string; evidence?: string }>,
  extraNames: string[],
): any[] {
  const seen = new Set(base.map(s => normalizeString(s.name || '')));
  const merged = [...base];
  for (const name of extraNames) {
    const norm = normalizeString(name || '');
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    merged.push({ name: name.trim(), evidence: name.trim() });
  }
  return merged;
}

// ── PersistBuilderOutput activity (Task 1.2 — all I/O outside orchestrator) ──
export interface PersistBuilderOutputInput {
  runId: string;
  person?: {
    id: string;
    tenantId: string;
    canonicalName: string;
    aliases: string[];
    dedupStatus: 'system_matched' | 'recruiter_selected' | 'needs_review';
  };
  facts: Array<Record<string, any>>;
  bullets: Array<Record<string, any>>;
}

export interface PersistBuilderOutputResult {
  factsPersisted: number;
  bulletsPersisted: number;
  personPersisted: boolean;
  searchIndexed: boolean;
}

/**
 * Activity that handles all side-effecting I/O for builder output:
 *   - Upsert the resolved Person doc (so the persons container is populated and
 *     relationship inference / UI navigation have a record to anchor to)
 *   - Bulk upsert of FactVersions / BulletMappings to PostgreSQL
 *   - Index both into Azure AI Search (best-effort)
 *
 * Called via df.callActivity() from the orchestrator so all I/O (and the
 * non-deterministic timestamps) happen outside the replay boundary. Run status
 * is owned by the orchestrator's UpdateExtractionRunStatus calls.
 */
export async function persistBuilderOutput(
  _context: any,
  input: PersistBuilderOutputInput,
): Promise<PersistBuilderOutputResult> {
  let searchOk = false;
  let personOk = false;

  // Phase 0: Upsert the resolved Person (timestamp generated inside the activity).
  if (input.person?.id) {
    const now = new Date().toISOString();
    const existing = await persist.getPerson(input.person.id);
    await persist.upsertPerson({
      ...input.person,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    } as any);
    personOk = true;
  }

  // Phase 1: Persist facts + bullets to PostgreSQL (best-effort per-item).
  await persist.persistBuildResults(input.facts as any, input.bullets as any);

  // Phase 2: Index into Azure AI Search (best-effort; errors logged in-indexer).
  try {
    if (input.facts.length > 0) await persist.indexFactsToSearch(input.facts as any);
    if (input.bullets.length > 0) await persist.indexBulletsToSearch(input.bullets as any);
    searchOk = true; // indexer caught its own errors internally
  } catch {
    // non-fatal — logged inside index helpers
  }

  return {
    factsPersisted: input.facts.length,
    bulletsPersisted: input.bullets.length,
    personPersisted: personOk,
    searchIndexed: searchOk,
  };
}

// Register the persistence activity (previously missing — the orchestrator
// called PersistBuilderOutput but no handler was registered).
app.activity('PersistBuilderOutput', {
  handler: (input: PersistBuilderOutputInput, context: any) => persistBuilderOutput(context, input),
});

// Register orchestrator with the Durable Functions runtime.
app.orchestration('IngestCandidateOrchestrator', ingestCandidateOrchestrator);
