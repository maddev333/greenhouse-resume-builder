/** Summary Section Agent: generates candidate profile summaries from extracted facts. */

import { app } from 'durable-functions';
import { actx, modelGenerateSummary } from '../services/agent-runtime';
import type { ExtractedEmployment } from './experience-segment';
import type { ExtractedSkill } from './skills';
import type { ExtractedEducationEntry } from './education';

export interface SummaryPayload {
  /** The generated profile summary text (2-3 sentences). */
  summary: string;
  /** Structured facts used to build the summary. */
  metadata: {
    yearsOfExperience: number;
    topSkills: string[];
    highestDegree?: string;
    employerCount: number;
    uniqueSkills: number;
  };
}

/** Normalize education degree to a sortable priority level. */
function degreePriority(degree: string): number {
  const normalized = degree.trim().toLowerCase();
  if (/phd|doctorate/.test(normalized)) return 50;
  if (/master|m\.?sc|M\.?BA/.test(normalized)) return 40;
  if (/\bba\b|\bbs\b|\bb\.sc\b|\bacademi/.test(normalized)) return 30;
  if (/associate|diploma/.test(normalized)) return 20;
  return 10;
}

/** Extract earliest start date from employment entries. */
function findEarliestDateString(entries: ExtractedEmployment[]): string | null {
  let earliest: string | null = null;
  for (const entry of entries) {
    if (!entry.startDate) continue;
    // Try to extract year portion
    const match = entry.startDate.match(/(\d{4})/);
    if (match) {
      const year = parseInt(match[1], 10);
      const currentEarliest = earliest ? parseInt(earliest, 10) : Infinity;
      if (year < currentEarliest) earliest = entry.startDate;
    }
  }
  return earliest;
}

/** Compute years of experience from earliest date to now, with clamping. */
function computeYearsOfExperience(entries: ExtractedEmployment[], max: number): number {
  const yearStr = findEarliestDateString(entries);
  if (!yearStr) return 0;
  const started = parseInt(yearStr, 10);
  const current = new Date().getFullYear();
  return Math.min(current - started, max);
}

/** Collect top skills ranked by a simple heuristic: proficiency > name length > alphabetical. */
function collectTopSkills(skills: ExtractedSkill[], count: number): string[] {
  const ranked = [...skills].sort((a, b) => {
    // Sort by proficiency level (expert first), then name length descending (longer phrases first).
    const profOrder: Record<string, number> = { expert: 40, advanced: 30, intermediate: 20, beginner: 10 };
    const pa = profOrder[a.proficiency ?? ''] ?? 0;
    const pb = profOrder[b.proficiency ?? ''] ?? 0;
    if (pa !== pb) return pb - pa;
    if ((a.name ?? '').length !== (b.name ?? '').length) return (b.name ?? '').length - (a.name ?? '').length;
    return a.name.localeCompare(b.name);
  });
  return ranked.slice(0, count).map(s => s.name);
}

/** Generate a professional candidate summary from the extracted sections. */
function generateSummary(
  experience: ExtractedEmployment[],
  skills: ExtractedSkill[],
  education: ExtractedEducationEntry[],
): SummaryPayload {
  const topSkills = collectTopSkills(skills, 5);
  const yearsOfExp = computeYearsOfExperience(experience, 50);

  let highestDegree = '';
  for (const edu of education) {
    if (!edu.degree) continue;
    const priority = degreePriority(edu.degree);
    if (priority > degreePriority(highestDegree)) {
      highestDegree = edu.degree;
    }
  }

  // Build the summary sentence structure.
  const components: string[] = [];

  if (yearsOfExp >= 8) {
    if (highestDegree) {
      components.push(`${highestDegree} graduate with ${yearsOfExp}+ years`);
    } else {
      components.push(`${yearsOfExp}+ years`);
    }
  } else if (yearsOfExp >= 3) {
    components.push(`${yearsOfExp} years`);
  }

  if (topSkills.length > 0) {
    components.push(`of professional experience specializing in ${topSkills.slice(0, 3).join(', ')}${topSkills.length > 3 ? ` and ${topSkills.length - 3} other areas` : ''}`);
  } else {
    components.push('of professional experience');
  }

  const uniqueEmployers = new Set(experience.map(e => e.employerName)).size;
  if (uniqueEmployers > 1) {
    components.push(`across ${uniqueEmployers} different organizations`);
  } else if (uniqueEmployers === 1 && experience.length > 0) {
    const bestExp = experience.find(e => e.jobTitle.length > 0);
    if (bestExp) {
      components.push(`with ${bestExp.jobTitle} experience at ${bestExp.employerName}`);
    }
  }

  const summaryText = components.join(' ');
  
  return {
    summary: `${summaryText.charAt(0).toUpperCase() + summaryText.slice(1)}.`,
    metadata: {
      yearsOfExperience: yearsOfExp,
      topSkills,
      highestDegree: highestDegree || undefined,
      employerCount: uniqueEmployers,
      uniqueSkills: skills.length,
    },
  };
}

/** Durable Function activity — registered with the orchestrator for pipeline integration. */
export async function processSummarySection(
  context: any,
  input: { extract: ExtractedEmployment[]; skills: ExtractedSkill[]; education: ExtractedEducationEntry[] },
): Promise<SummaryPayload | null> {
  const experience = input.extract ?? [];
  const skills     = input.skills     ?? [];
  const education  = input.education  ?? [];

  if (experience.length === 0 && skills.length === 0 && education.length === 0) {
    return null;
  }

  context.logger.info('[SummaryAgent] Generating candidate profile summary...');
  const result = generateSummary(experience, skills, education);

  const modelSummary = await modelGenerateSummary({ experience, skills, education }, context.logger);
  if (modelSummary) {
    context.logger.info('[SummaryAgent] Using model-generated summary.');
    result.summary = modelSummary;
  }

  context.logger.info(`[SummaryAgent] Generated ${result.summary.length} character summary.`);
  return result;
}

app.activity('ProcessSummarySection', {
  handler: (input: any, context: any) => processSummarySection(actx(context), input),
});
