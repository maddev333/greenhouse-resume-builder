/** Education Section Agent: extracts degree/school info from resume text. */

import crypto from 'crypto';
import { app } from 'durable-functions';
import { actx, modelExtractEducation } from '../services/agent-runtime';

export interface ExtractedEducationEntry {
  id:           string;       // stable ID by factKey
  schoolName:   string;
  degree?:      string;
  fieldOfStudy?: string;
  startDate?:   string | null;
  endDate?:     string | null;
  location?:    string | null;
  confidence:   number;
}

/** Detect whether a line belongs in the education section vs experience. */
function isLikelyEducation(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  // Experience entries typically have job titles or company names without degree patterns
  if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(normalized)) return false;
  // Lines with job-title indicators are likely experience
  const jobIndicators = ['senior', 'junior', 'lead', 'manager', 'director', 'engineer',
    'developer', 'analyst', 'consultant', 'intern', 'president', 'vp', 'cto', 'cfo'];
  if (jobIndicators.some(w => normalized.includes(w))) return false;
  // Lines starting with a degree pattern are education
  return /^(bachelor|master|phd|msc|bsc|bs|ms|mba|mba|ba|ma|associate|diploma)/i.test(normalized);
}

/** Extract date ranges near the entry text. */
function extractDateRangeFromContext(fullText: string, entryStart: number): 
  { startDate: string | null; endDate: string | null } {
  
  const searchWindow = fullText.slice(Math.max(0, entryStart - 150), entryStart + 400);
  // Match YYYY or YYYY-MM patterns
  const yearPattern = /(\d{4})(?:[-](\d{2}))?/g;
  const dates: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = yearPattern.exec(searchWindow)) !== null) {
    dates.push(`${m[1]}-${(m[2] || '00')}`);
  }
  
  if (dates.length === 0) return { startDate: null, endDate: null };
  if (dates.length === 1) return { startDate: dates[0], endDate: null };
  // Sort chronologically
  const sorted = [...new Set(dates)].sort();
  const startYear = parseInt(sorted[0].split('-')[0]);
  const endYear   = parseInt(sorted[sorted.length - 1].split('-')[0]);
  
  if (endYear > startYear) {
    return { startDate: sorted[0], endDate: sorted[sorted.length - 1] };
  }
  return { startDate: dates[dates.length - 1], endDate: null };
}

/** Generate a stable ID from the entry's key components. */
function makeEducationEntryKey(entry: Partial<ExtractedEducationEntry>): string {
  const key = `${entry.degree ?? ''}||${entry.schoolName || ''}`;
  return crypto.createHash('sha256').update(key).digest('hex');
}

/** Match education entries from raw resume text (dedup-safe, context-aware). */
export function extractEducation(textBlocks: string[]): ExtractedEducationEntry[] {
  const fullText = textBlocks.join('\n');
  const seenKeys = new Set<string>();
  const entries: ExtractedEducationEntry[] = [];
  
  // Pattern 1: "Degree - School Name" format (e.g., "Bachelor of Science - MIT")
  const p1Pattern = /((?:Bachelor|Master|PhD|MSc|BSc|BS|MS|MBA|BA|MA)[a-zA-Z\s]*?)\s*[-*]\s*([A-Z][A-Za-z&'.\s-]{3,})/gi;
  let m: RegExpExecArray | null;
  
  while ((m = p1Pattern.exec(fullText)) !== null) {
    const rawDegree = m[1].trim();
    const schoolName = m[2].replace(/[-*]$/, '').trim();
    
    // Skip if not an education line (e.g., "Bachelor of Science - Google") is ambiguous
    if (!isLikelyEducation(rawDegree + ' - ' + schoolName)) continue;
    
    const degree = rawDegree.match(/(?:Bachelor|Master|PhD|MSc|BSc|BS|MS|MBA|BA|MA)/i)?.[0];
    if (!degree) continue;
    
    const entry: ExtractedEducationEntry = {
      id: makeEducationEntryKey({ schoolName, degree, startDate: null, endDate: null, confidence: 0 }),
      schoolName,
      degree,
      fieldOfStudy: undefined,
      startDate: null,
      endDate: null,
      location: null,
      confidence: 0.85,
    };

    // Extract date range from context near the match position
    const dates = extractDateRangeFromContext(fullText, m.index);
    entry.startDate = dates.startDate;
    entry.endDate   = dates.endDate || entry.startDate;

    if (!seenKeys.has(entry.id)) { seenKeys.add(entry.id); entries.push(entry); }
  }

  // Pattern 2: "School Name - Degree" format (only for lines that look like education)
  const p2Pattern = /([A-Z][a-zA-Z&'.\s-]{3,})\s*[-*]\s*((?:Bachelor|Master|PhD|MSc|BSc)[a-zA-Z\s]*?)/gi;
  m = null;
  while ((m = p2Pattern.exec(fullText)) !== null) {
    const schoolName = m[1].trim();
    const rawDegree  = m[2].trim();
    
    if (!isLikelyEducation(rawDegree)) continue;
    
    const degree = rawDegree.match(/(?:Bachelor|Master|PhD|MSc|BSc)/i)?.[0];
    if (!degree) continue;
    
    // Avoid overlap with pattern 1 matches
    const key = crypto.createHash('sha256')
      .update(`${schoolName}||${degree}`).digest('hex');
    if (seenKeys.has(key)) continue;
    
    const entry: ExtractedEducationEntry = {
      id: key,
      schoolName, degree,
      fieldOfStudy: undefined,
      startDate: null, endDate: null, location: null,
      confidence: 0.85,
    };

    // Extract date range from context
    const dates = extractDateRangeFromContext(fullText, m.index);
    entry.startDate = dates.startDate;
    entry.endDate   = dates.endDate || entry.startDate;

    seenKeys.add(key);
    entries.push(entry);
  }

  return entries;
}

/** Durable Function activity — registered with the orchestrator. */
export async function processEducationSection(
  context: any,
  input: { runId?: string; textBlocks: string[] },
): Promise<ExtractedEducationEntry[]> {
  const textBlocks = input?.textBlocks ?? [];
  if (textBlocks.length === 0) {
    context.logger.info('[Education] No text blocks to process.');
    return [];
  }

  const modelEntries = await modelExtractEducation(textBlocks.join('\n'), context.logger);
  if (modelEntries && modelEntries.length > 0) {
    context.logger.info(`[Education] Model extracted ${modelEntries.length} education entries.`);
    return modelEntries;
  }

  context.logger.info(`[Education] Extracting education from ${textBlocks.length} text blocks (heuristic)...`);
  const entries = extractEducation(textBlocks);
  context.logger.info(`[Education] Found ${entries.length} education entries.`);
  return entries;
}

app.activity('ProcessEducationSection', {
  handler: (input: any, context: any) => processEducationSection(actx(context), input),
});
