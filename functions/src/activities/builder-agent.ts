/** Build FactVersion + BulletMapping artifacts from extracted section results. */

import { createHash } from 'crypto';
import { app } from 'durable-functions';
import type { BulletMapping, FactVersion } from '@greenhouse-resume-builder/shared';
import { makeBulletSignature, normalizeDate, normalizeEmployerName, normalizeString } from '@greenhouse-resume-builder/shared';
import type { ExtractedEmployment } from './experience-segment';
import type { ExtractedSkill } from './skills';
import type { ExtractedEducationEntry } from './education';

// ── Input / Output contracts ─────────────────────────────────────────────

export interface BuilderAgentInput {
  runId: string;
  tenantId?: string;
  personId: string;
  sourceDocumentIds?: string[];
  extracted?: {
    experience?: ExtractedEmployment[];
    skills?: ExtractedSkill[];
    education?: ExtractedEducationEntry[];
  };
  summaryText?: string;
  summaryMetadata?: Record<string, any>;
  profile?: {
    headline?: string | null;
    currentTitle?: string | null;
    currentOrganization?: string | null;
    location?: string | null;
    achievements?: string[];
    affiliations?: string[];
    links?: string[];
  };
}

export interface BuilderAgentOutput {
  personId: string;
  extractionRunId: string;
  facts: FactVersion[];
  bullets: BulletMapping[];
  summary?: { text: string; metadata: Record<string, any> };
  stats: { factCount: number; bulletCount: number };
}

type SupportedSection = FactVersion['sectionId'];

// ── Deterministic identity helpers (Task 2.1 — idempotent builder outputs) ───

/** Produce a stable, content-based fact ID for idempotent upserts. */
function deterministicFactId(
  personId: string, extractionRunId: string,
  sectionId: SupportedSection, factKey: string, valueString: string,
): string {
  const raw = `${personId}|${extractionRunId}|${sectionId}|${factKey}|${valueString}`;
  return `f_${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`;
}

/** Produce a stable, content-based bullet ID (includes personId to avoid cross-person collisions). */
function deterministicBulletId(
  personId: string, sectionId: SupportedSection, bulletText: string,
): string {
  const raw = `${personId}|${sectionId}|${normalizeString(bulletText)}`;
  return `b_${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`;
}

// ── Factory helpers (deterministic identities for idempotency) ───────────────

function makeFact(
  tenantId: string, personId: string, extractionRunId: string,
  sectionId: SupportedSection, factKey: string, factValue: string | object,
  normalizedValue: string, sourceDocumentIds: string[], confidence = 0.75,
): FactVersion {
  const valueString = typeof factValue === 'string' ? factValue : JSON.stringify(factValue);
  return {
    id: deterministicFactId(personId, extractionRunId, sectionId, factKey, valueString),
    tenantId, personId, extractionRunId, sectionId,
    factKey, factValue, normalizedValue,
    extractedAt: new Date().toISOString(),
    confidence, status: 'extracted', sourceDocumentIds,
  };
}

function makeBullet(
  tenantId: string, personId: string, extractionRunId: string, sectionId: SupportedSection,
  bulletText: string, citationFactVersionIds: string[], citationSourceDocumentIds: string[],
): BulletMapping {
  return {
    id: deterministicBulletId(personId, sectionId, bulletText),
    tenantId, personId, extractionRunId, sectionId, bulletText,
    bulletSignature: makeBulletSignature(normalizeString(bulletText)),
    citationFactVersionIds, citationSourceDocumentIds, latestForBullet: true,
    createdAt: new Date().toISOString(),
  };
}

// ── Section artifact builders ──────────────────────────────────────────────

function buildExperienceArtifacts(
  tenantId: string, personId: string, extractionRunId: string,
  sourceDocumentIds: string[], experience: ExtractedEmployment[],
): { facts: FactVersion[]; bullets: BulletMapping[] } {
  const facts: FactVersion[] = [];
  const bullets: BulletMapping[] = [];

  for (const item of experience) {
    let itemFactIds: string[] = [];

    // Item-level source doc references (only first doc used)
    const sourceDocRefs = sourceDocumentIds.slice(0, 1);

    const employerFact = makeFact(
      tenantId, personId, extractionRunId, 'experience',
      'employment.employer_name', item.employerName,
      normalizeEmployerName(item.employerName), sourceDocRefs, 0.85);
    const titleFact = makeFact(
      tenantId, personId, extractionRunId, 'experience',
      'employment.job_title', item.jobTitle ?? '',
      normalizeString(item.jobTitle ?? ''), sourceDocRefs, 0.8);

    facts.push(employerFact, titleFact);
    itemFactIds.push(employerFact.id, titleFact.id);

    if (item.startDate) {
      const dFact = makeFact(
        tenantId, personId, extractionRunId, 'experience',
        'employment.start_date', item.startDate,
        normalizeDate(item.startDate), sourceDocRefs, 0.65);
      facts.push(dFact);
      itemFactIds.push(dFact.id);
    }
    if (item.endDate) {
      const dFact = makeFact(
        tenantId, personId, extractionRunId, 'experience',
        'employment.end_date', item.endDate,
        normalizeDate(item.endDate), sourceDocRefs, 0.65);
      facts.push(dFact);
      itemFactIds.push(dFact.id);
    }

    bullets.push(
      makeBullet(
        tenantId, personId, extractionRunId, 'experience',
        item.jobTitle ? `${item.jobTitle} at ${item.employerName}` : `Worked at ${item.employerName}`,
        itemFactIds, sourceDocumentIds));
  }
  return { facts, bullets };
}

function buildSkillsArtifacts(
  tenantId: string, personId: string, extractionRunId: string,
  sourceDocumentIds: string[], skills: ExtractedSkill[],
): { facts: FactVersion[]; bullets: BulletMapping[] } {
  const facts: FactVersion[] = [];
  const bullets: BulletMapping[] = [];

  for (const skill of skills) {
    const sourceDocRefs = sourceDocumentIds.slice(0, 1);
    const fact = makeFact(
      tenantId, personId, extractionRunId, 'skills', 'skills.keyword',
      { name: skill.name, proficiency: skill.proficiency ?? null, evidence: skill.evidence },
      normalizeString(`${skill.name} ${skill.proficiency ?? ''}`), sourceDocRefs, 0.8);
    facts.push(fact);

    bullets.push(
      makeBullet(
        tenantId, personId, extractionRunId, 'skills',
        skill.proficiency ? `${skill.name} \u2014 ${skill.proficiency}` : skill.name,
        [fact.id], sourceDocumentIds));
  }
  return { facts, bullets };
}

function buildEducationArtifacts(
  tenantId: string, personId: string, extractionRunId: string,
  sourceDocumentIds: string[], education: ExtractedEducationEntry[],
): { facts: FactVersion[]; bullets: BulletMapping[] } {
  const facts: FactVersion[] = [];
  const bullets: BulletMapping[] = [];

  for (const item of education) {
    const sourceDocRefs = sourceDocumentIds.slice(0, 1);
    const schoolFact = makeFact(
      tenantId, personId, extractionRunId, 'education',
      'education.school_name', item.schoolName,
      normalizeString(item.schoolName), sourceDocRefs, 0.85);
    facts.push(schoolFact);

    let degreeFact: FactVersion | undefined;
    if (item.degree) {
      degreeFact = makeFact(
        tenantId, personId, extractionRunId, 'education',
        'education.degree', item.degree,
        normalizeString(item.degree), sourceDocRefs, 0.8);
      facts.push(degreeFact);
    }

    bullets.push(
      makeBullet(
        tenantId, personId, extractionRunId, 'education',
        item.degree ? `${item.degree}, ${item.schoolName}` : item.schoolName,
        [schoolFact.id, ...(degreeFact ? [degreeFact.id] : [])], sourceDocumentIds));
  }
  return { facts, bullets };
}

function buildProfileArtifacts(
  tenantId: string, personId: string, extractionRunId: string,
  sourceDocumentIds: string[], profile: NonNullable<BuilderAgentInput['profile']>,
): { facts: FactVersion[]; bullets: BulletMapping[] } {
  const facts: FactVersion[] = [];
  const bullets: BulletMapping[] = [];
  const sourceDocRefs = sourceDocumentIds.slice(0, 1);

  const addFactBullet = (factKey: string, value: string, bulletText: string, confidence = 0.7) => {
    const trimmed = (value ?? '').trim();
    if (!trimmed) return;
    const fact = makeFact(
      tenantId, personId, extractionRunId, 'profile', factKey, trimmed,
      normalizeString(trimmed), sourceDocRefs, confidence);
    facts.push(fact);
    bullets.push(makeBullet(
      tenantId, personId, extractionRunId, 'profile', bulletText, [fact.id], sourceDocumentIds));
  };

  if (profile.headline) addFactBullet('profile.headline', profile.headline, profile.headline, 0.75);

  if (profile.currentTitle || profile.currentOrganization) {
    const role = [profile.currentTitle, profile.currentOrganization].filter(Boolean).join(' at ');
    addFactBullet('profile.current_role',
      JSON.stringify({ title: profile.currentTitle ?? null, organization: profile.currentOrganization ?? null }),
      role, 0.75);
  }

  if (profile.location) addFactBullet('profile.location', profile.location, `Based in ${profile.location}`, 0.7);

  for (const achievement of profile.achievements ?? []) {
    addFactBullet('profile.achievement', achievement, achievement, 0.65);
  }
  for (const affiliation of profile.affiliations ?? []) {
    addFactBullet('profile.affiliation', affiliation, affiliation, 0.65);
  }
  for (const link of profile.links ?? []) {
    addFactBullet('profile.link', link, link, 0.6);
  }

  return { facts, bullets };
}

export function buildResumeArtifacts(input: BuilderAgentInput): BuilderAgentOutput {
  const tenantId = input.tenantId ?? 'tenant-default';
  const sourceDocumentIds = input.sourceDocumentIds ?? [];
  const extracted = input.extracted ?? {};

  const expArtifacts  = buildExperienceArtifacts(tenantId, input.personId, input.runId, sourceDocumentIds, extracted.experience ?? []);
  const skillArtifacts = buildSkillsArtifacts(tenantId, input.personId, input.runId, sourceDocumentIds, extracted.skills ?? []);
  const eduArtifacts   = buildEducationArtifacts(tenantId, input.personId, input.runId, sourceDocumentIds, extracted.education ?? []);
  const profileArtifacts = input.profile
    ? buildProfileArtifacts(tenantId, input.personId, input.runId, sourceDocumentIds, input.profile)
    : { facts: [] as FactVersion[], bullets: [] as BulletMapping[] };

  // Optional summary facts + bullet.
  let summaryFacts: FactVersion[] = [];
  let summaryFactIds: string[] = [];
  if (input.summaryText?.trim()) {
    const summarySourceDocs = sourceDocumentIds.slice(0, 1);
    const summaryFact = makeFact(
      tenantId, input.personId, input.runId, 'summary', 'summary.profile',
      input.summaryText, normalizeString(input.summaryText), summarySourceDocs, 0.85);
    summaryFacts.push(summaryFact);
    summaryFactIds.push(summaryFact.id);

    const yearsExp = input.summaryMetadata?.yearsOfExperience as number | undefined;
    if (yearsExp) {
      const yrsFact = makeFact(
        tenantId, input.personId, input.runId, 'summary', 'summary.years_experience',
        `+${yearsExp}`, String(yearsExp).toLowerCase(), summarySourceDocs, 0.75);
      summaryFacts.push(yrsFact);
      summaryFactIds.push(yrsFact.id);
    }
  }

  const allFacts = [...expArtifacts.facts, ...skillArtifacts.facts, ...eduArtifacts.facts, ...profileArtifacts.facts, ...summaryFacts];
  const allBullets: BulletMapping[] = [
    ...expArtifacts.bullets, ...skillArtifacts.bullets, ...eduArtifacts.bullets, ...profileArtifacts.bullets,
  ];

  if (input.summaryText?.trim()) {
    allBullets.push(
      makeBullet(tenantId, input.personId, input.runId, 'summary', input.summaryText, summaryFactIds, sourceDocumentIds));
  }

  return {
    personId: input.personId,
    extractionRunId: input.runId,
    facts: allFacts,
    bullets: allBullets,
    summary: input.summaryText ? { text: input.summaryText, metadata: input.summaryMetadata ?? {} } : undefined,
    stats: { factCount: allFacts.length, bulletCount: allBullets.length },
  };
}

export async function ResumeBuilderAgentActivity(_context: any, input: BuilderAgentInput) {
  return buildResumeArtifacts(input);
}

app.activity('ResumeBuilderAgent', {
  handler: (input: any, context: any) => ResumeBuilderAgentActivity(context, input),
});
