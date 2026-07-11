/**
 * Grounding catalog for the orchestrator's prompt + deterministic router.
 *
 * The leader roster and topic taxonomy live in the demo seed (the same source the capability
 * indexes). Leaders are NOT exposed as an MCP tool, so the orchestrator reads them here to
 * (a) inject a valid roster into the system prompt and (b) resolve a default leader when the
 * user does not name one. Topic keyword mapping powers the no-LLM fallback.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SEED_DIR = resolve(import.meta.dirname, '..', '..', '..', '..', 'engagement-intelligence', 'seed');

export interface Leader {
  id: string;
  name: string;
  role: string;
  domain: string;
  smeAreas: string[];
  homeBase: { city: string; state: string };
}

export interface Topic {
  id: string;
  name: string;
  smeAreas: string[];
}

function readSeed<T>(file: string): T {
  return JSON.parse(readFileSync(resolve(SEED_DIR, file), 'utf-8')) as T;
}

let _leaders: Leader[] | null = null;
let _topics: Topic[] | null = null;

export function loadLeaders(): Leader[] {
  return (_leaders ??= readSeed<Leader[]>('leaders.json'));
}

export function loadTopics(): Topic[] {
  return (_topics ??= readSeed<Topic[]>('topics.json'));
}

/** The leader whose time is planned when the user does not name one. */
export function resolveDefaultLeaderId(): string {
  const env = process.env.ENGAGEMENTS_DEFAULT_LEADER?.trim();
  if (env && loadLeaders().some((l) => l.id === env)) return env;
  return loadLeaders()[0]?.id ?? 'L1';
}

/**
 * Keyword -> topicId, used by the deterministic fallback to map a free-text ask
 * ("UAS/drone", "cyber") onto the seed taxonomy. The LLM path does this via the prompt.
 */
const TOPIC_KEYWORDS: Record<string, string[]> = {
  T1: ['industrial base', 'dib', 'supply chain', 'munition', 'acquisition', 'contracting'],
  T2: ['cyber', 'zero-trust', 'zero trust', 'c5isr', 'network defense'],
  T3: ['uas', 'drone', 'autonom', 'startup', 'innovation', 'venture', 'dual-use', 'non-traditional'],
  T4: ['stem', 'talent', 'recruit', 'workforce'],
};

export function topicIdsFromText(text: string): string[] {
  const t = text.toLowerCase();
  return Object.entries(TOPIC_KEYWORDS)
    .filter(([, kws]) => kws.some((k) => t.includes(k)))
    .map(([id]) => id);
}

export function rosterForPrompt(): string {
  return loadLeaders()
    .map(
      (l) =>
        `  ${l.id}: ${l.name} — ${l.role} [${l.domain}], home ${l.homeBase.city}, ${l.homeBase.state}; SME ${l.smeAreas.join('/')}`,
    )
    .join('\n');
}

export function topicsForPrompt(): string {
  return loadTopics()
    .map((t) => `  ${t.id}: ${t.name} (${t.smeAreas.join(', ')})`)
    .join('\n');
}
