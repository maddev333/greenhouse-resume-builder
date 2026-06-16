/** MVP Experience Segment Processor: extracts employment data via regex patterns. */

import { app } from 'durable-functions';
import type { FactVersion, BulletMapping } from '@greenhouse-resume-builder/shared';
import { actx, modelExtractExperience } from '../services/agent-runtime';

export interface ExtractedEmployment {
  employerName: string;
  jobTitle:     string;
  startDate:    string | null;
  endDate:      string | null;
  location:     string | null;
  description?: string;
}

/** Parse employment entries from raw resume text using regex patterns. */
export function extractExperienceSegments(text: string): ExtractedEmployment[] {
  const results: ExtractedEmployment[] = [];

  // Pattern 1: "Company - Title" (dash-separated)
  const companyPattern = /(?:^|\n\s*)(([A-Z][A-Za-z&'.\s-]+?)\s*[-*]\s*([^\n|]+?)(?:\||,)?)/gmi;
  let match: RegExpExecArray | null;

  while ((match = companyPattern.exec(text)) !== null) {
    const employerName = match[2].trim().replace(/[-*]/g, '').trim();
    if (employerName.length > 1 && !['January', 'February'].includes(employerName)) {
      results.push({
        employerName,
        jobTitle: match[3] ? match[3].trim() : '',
        startDate: null, endDate: null, location: null,
      });
    }
  }

  // Pattern 2: "Title at Company" format
  const titlePattern = /(?:^|\n\s*)([A-Z][a-z]+(?:\s+[A-Za-z]+)+)\s+at\s+([A-Z][A-Za-z&'.\s-]+)/gm;
  match = null;
  while ((match = titlePattern.exec(text)) !== null) {
    const title     = match[1].trim();
    const employer  = match[2].trim();
    if (employer.length > 2 && title.split(/\s+/).length >= 2 && title !== 'At') {
      const already = results.find(e => e.employerName.toLowerCase() === employer.toLowerCase());
      if (!already) {
        results.push({ employerName: employer, jobTitle: title, startDate: null, endDate: null, location: null });
      }
    }
  }

  return results;
}

/** Extract date ranges from context near employment entries. */
function enhanceDates(experiences: ExtractedEmployment[], text: string): void {
  // Match "Jan 2019 - Dec 2023" or similar patterns
  const datePattern = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{2,4})/gi;
  let match: RegExpExecArray | null;

  while ((match = datePattern.exec(text)) !== null) {
    for (const exp of experiences) {
      const idx = text.indexOf(exp.employerName, Math.max(0, match.index - 200));
      if (idx >= 0 && Math.abs(idx - match.index) < 350) {
        if (!exp.startDate) exp.startDate = `${match[2]}`; // Store as string for MVP
      }
    }
  }
}

// Durable Function activity — registered with the Durable Functions runtime.
export async function extractMvpExperienceSegments(context: any, input: { runId?: string; textBlocks?: string[] }) {
  const textChunks = input?.textBlocks ?? [];
  const fullText = textChunks.join('\n');

  const modelResult = await modelExtractExperience(fullText, context.logger);
  if (modelResult && modelResult.length > 0) {
    context.logger.info(`[Experience] Model extracted ${modelResult.length} employment entries.`);
    return modelResult;
  }

  context.logger.info('[Experience] Extracting employment data (heuristic)...');
  const experiences = extractExperienceSegments(fullText);
  enhanceDates(experiences, fullText);

  return experiences;
}

app.activity('ExtractMvpExperienceSegment', {
  handler: (input: any, context: any) => extractMvpExperienceSegments(actx(context), input),
});

/** Run this function independently for batch extraction. */
export async function runBatch(textChunks: string[], runId?: string): Promise<ExtractedEmployment[]> {
  return await extractMvpExperienceSegments({ logger: { info: (m: string) => runId ? console.log(`[Experience][run=${runId}] ${m}`) : null, warn: () => {} } }, { textBlocks: textChunks, runId });
}
