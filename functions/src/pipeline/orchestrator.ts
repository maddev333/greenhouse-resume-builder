/**
 * IngestCandidateOrchestrator - MVP Durable Functions orchestrator.
 *
 * Pipeline: fetch -> normalize -> section agents (parallel) -> dedup -> builder-agent -> persist
 */

import { app } from 'durable-functions';
import * as persist from '../persistence/index';

interface OrchestrationInput {
  runId:      string;
  personOverride?: string;
  webUrls?:   string[];
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
  const log = (msg: string) => { if (!df.isReplaying) context.log(msg); };

  log('[Orchestrator] Starting ingestion for run ' + runId);

  // Mark the run in_progress so the UI can reflect live status.
  yield df.callActivity('UpdateExtractionRunStatus', { runId, status: 'in_progress' });

  // ── Gate 1: Process uploads + fetch web sources ──
  const uploadResult = yield df.callActivity('StoreUploadsAndExtract', { runId });
  const webUrlsFromDocs = (uploadResult?.sourceDocs || [])
    .filter((d: any) => d.uri && d.sourceType === 'web')
    .map((d: any) => d.uri);
  const webInputUrls = input.webUrls ?? [];
  const allWebUrls = [...new Set([...webUrlsFromDocs, ...webInputUrls.filter(Boolean)])];

  const snapshotResults: any[] = allWebUrls.length > 0
    ? yield df.callActivity('FetchAndSnapshotWebSources', { runId, webUrls: allWebUrls })
    : [];

  const normalizedTextBlocks: string[] = [...(uploadResult?.textBlocks ?? [])];
  if (snapshotResults.length > 0) {
    const snippets = snapshotResults.map((r: any) => r.contentSnippet).filter(Boolean);
    normalizedTextBlocks.push(...snippets);
  }

  const sectionTexts = normalizeSections(normalizedTextBlocks);

  // ── Gate 2A-C: Section agents in parallel (experience, skills, education) ──
  const sectionTasks = [
    df.callActivity('ExtractMvpExperienceSegment', { runId, textBlocks: sectionTexts.experience ?? [] }),
    df.callActivity('ProcessMvpSkillsSection', { runId, textBlocks: sectionTexts.skills ?? [] }),
    df.callActivity('ProcessEducationSection', { runId, textBlocks: sectionTexts.education ?? [] }),
  ];
  const [experienceResult, skillsList, educationResult] = yield df.Task.all(sectionTasks);

  // ── Gate 3: Person dedup ──
  const nameMatch = extractNameFromText(normalizedTextBlocks);
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
  } catch (err: any) {
    log(`[Orchestrator] Summary generation failed (non-fatal): ${err?.message || err}`);
  }

  const sourceDocumentIds = (uploadResult?.sourceDocs ?? []).map((d: any) => d.id);

  // ── Gate 4b: Builder-agent stage (resume building) ──
  const builderOutput = yield df.callActivity('ResumeBuilderAgent', {
    runId,
    tenantId: 'tenant-default',
    personId,
    sourceDocumentIds,
    extracted: {
      experience: experienceSegs,
      skills: skillsResults.map((s, i) => ({ name: s.name || `skill_${i}`, proficiency: s.proficiency, evidence: s.evidence })),
      education: eduResults,
    },
    summaryText: summaryPayload?.summary,
    summaryMetadata: summaryPayload?.metadata,
  });

  log(`[Orchestrator] Builder-agent complete - ${builderOutput.stats.factCount} facts, ${builderOutput.stats.bulletCount} bullets`);

  // ── Gate 5: Persist Person + builder output (all I/O inside the activity) ──
  const persistResult = yield df.callActivity('PersistBuilderOutput', {
    runId,
    person: {
      id: personId,
      tenantId: 'tenant-default',
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

/** Extract candidate name from resume text using pattern matching. */
function extractNameFromText(chunks: string[]): string | null {

  for (const chunk of chunks) {
    const trimmed = chunk.trim().replace(/[-*~]+/g, '');
    if (trimmed.length > 2 && trimmed.length < 60 && /^[A-Z][a-zA-Z\s&']+$/.test(trimmed)) {
      return trimmed;
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
 *   - Bulk upsert of FactVersions / BulletMappings to Cosmos DB
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

  // Phase 1: Persist facts + bullets to Cosmos DB (best-effort per-item).
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
