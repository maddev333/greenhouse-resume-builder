/**
 * Model-backed agent runtime for extraction activities.
 *
 * Provides ONE reusable way for Durable Functions *activities* (never the
 * orchestrator) to call an Azure OpenAI / Azure AI Foundry chat model with a
 * strict JSON contract, while always preserving a deterministic heuristic
 * fallback. Behaviour is controlled by environment variables:
 *
 *   AGENT_MODE                = heuristic | model | hybrid   (default: hybrid)
 *   AZURE_OPENAI_ENDPOINT     = https://<resource>.openai.azure.com
 *   AZURE_OPENAI_API_KEY      = <key>
 *   AZURE_OPENAI_DEPLOYMENT   = <chat deployment name>
 *   AZURE_OPENAI_API_VERSION  = 2024-10-21 (default)
 *   AZURE_OPENAI_TIMEOUT_MS   = 30000 (default)
 *
 * Design rules (see mvp_implementation_plan.md Priority 2):
 *  - Model calls happen only inside activities, via this module.
 *  - Output must be JSON-parseable; invalid/empty output returns null so the
 *    caller falls back to its heuristic extractor instead of persisting
 *    untrusted data.
 *  - When the model is unavailable we log a warning and fall back; we never
 *    silently pretend a model result succeeded.
 */

import type { ExtractedEmployment } from '../activities/experience-segment';
import type { ExtractedSkill } from '../activities/skills';
import type { ExtractedEducationEntry } from '../activities/education';

import { DefaultAzureCredential } from '@azure/identity';

export type AgentMode = 'heuristic' | 'model' | 'hybrid';

interface MiniLogger {
  info?: (...a: any[]) => void;
  warn?: (...a: any[]) => void;
  error?: (...a: any[]) => void;
}

// ── Activity context shim ────────────────────────────────────────────────────
// Durable Functions v3 invokes activity handlers as (input, context) where
// `context` is an @azure/functions InvocationContext exposing .log/.warn/.error.
// The existing activity bodies were written against a `context.logger.info(...)`
// shape, so this adapter attaches a `.logger` proxy that forwards to the real
// context methods (preserving `this`) and falls back to console.

function callLog(context: any, level: string, args: any[]): void {
  try {
    if (context && typeof context[level] === 'function') { context[level](...args); return; }
    if (context && typeof context.log === 'function') { context.log(...args); return; }
  } catch {
    /* fall through to console */
  }
  const fn = (console as any)[level] ?? console.log;
  fn(...args);
}

/** Return the activity context with a `.logger` proxy (`info`/`warn`/`error`/`log`). */
export function actx(context: any): any {
  if (!context || typeof context !== 'object') {
    return { logger: console, log: console.log.bind(console) };
  }
  if (!context.logger) {
    context.logger = {
      log: (...a: any[]) => callLog(context, 'log', a),
      info: (...a: any[]) => callLog(context, 'info', a),
      warn: (...a: any[]) => callLog(context, 'warn', a),
      error: (...a: any[]) => callLog(context, 'error', a),
      debug: (...a: any[]) => callLog(context, 'debug', a),
    };
  }
  return context;
}

// ── Mode + configuration helpers ─────────────────────────────────────────────

export function getAgentMode(): AgentMode {
  const m = (process.env.AGENT_MODE || 'hybrid').toLowerCase();
  if (m === 'heuristic' || m === 'model') return m;
  return 'hybrid';
}

export function isModelConfigured(): boolean {
  // Auth is either an API key or managed identity (Entra), so only endpoint + deployment are required.
  return !!(
    process.env.AZURE_OPENAI_ENDPOINT &&
    process.env.AZURE_OPENAI_DEPLOYMENT
  );
}

let _warnedUnconfigured = false;

/** Whether a section activity should attempt a model call before the heuristic. */
export function shouldUseModel(logger?: MiniLogger): boolean {
  const mode = getAgentMode();
  if (mode === 'heuristic') return false;
  if (!isModelConfigured()) {
    if (!_warnedUnconfigured) {
      _warnedUnconfigured = true;
      logger?.warn?.(
        `[AgentRuntime] AGENT_MODE=${mode} but Azure OpenAI is not configured; ` +
          `falling back to deterministic heuristics. Set AZURE_OPENAI_ENDPOINT/API_KEY/DEPLOYMENT to enable.`,
      );
    }
    return false;
  }
  return true;
}

// ── Core chat-completions call (strict JSON) ─────────────────────────────────
let _aoaiCredential: DefaultAzureCredential | undefined;

/**
 * Build the auth header for Azure OpenAI. Uses AZURE_OPENAI_API_KEY when present;
 * otherwise acquires a Microsoft Entra ID bearer token via managed identity (required
 * for DoD IL5). The token scope is cloud-configurable via AZURE_OPENAI_TOKEN_SCOPE
 * (Gov: https://cognitiveservices.azure.us/.default).
 */
async function getAoaiAuthHeaders(): Promise<Record<string, string>> {
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  if (apiKey) return { 'api-key': apiKey };

  if (!_aoaiCredential) _aoaiCredential = new DefaultAzureCredential();
  const scope = process.env.AZURE_OPENAI_TOKEN_SCOPE || 'https://cognitiveservices.azure.com/.default';
  const token = await _aoaiCredential.getToken(scope);
  if (!token?.token) throw new Error('Failed to acquire Azure OpenAI access token via managed identity');
  return { Authorization: `Bearer ${token.token}` };
}
async function chatJson(system: string, user: string, logger?: MiniLogger, label = 'model'): Promise<any | null> {
  if (!isModelConfigured()) return null;

  const endpoint = process.env.AZURE_OPENAI_ENDPOINT!.replace(/\/+$/, '');
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT!;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-10-21';
  const timeoutMs = Number(process.env.AZURE_OPENAI_TIMEOUT_MS || 30000);
  const url = `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${apiVersion}`;

  const promptChars = system.length + user.length;
  logger?.info?.(`[AgentRuntime] ${label}: calling ${deployment} (prompt ${promptChars} chars, timeout ${timeoutMs}ms)…`);
  const startedAt = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const authHeaders = await getAoaiAuthHeaders();
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0,
        // GPT-4o and GPT-5-class deployments require max_completion_tokens; max_tokens is rejected.
        max_completion_tokens: 1800,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });

    const elapsedMs = Date.now() - startedAt;
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      logger?.warn?.(`[AgentRuntime] ${label}: model HTTP ${resp.status} after ${elapsedMs}ms — ${body.slice(0, 300)}`);
      return null;
    }

    const data: any = await resp.json();
    const content: string | undefined = data?.choices?.[0]?.message?.content;
    const usage = data?.usage;
    if (!content) {
      logger?.warn?.(`[AgentRuntime] ${label}: model returned empty content after ${elapsedMs}ms`);
      return null;
    }
    logger?.info?.(
      `[AgentRuntime] ${label}: ${deployment} responded in ${elapsedMs}ms ` +
        `(${content.length} chars` +
        (usage ? `, tokens ${usage.prompt_tokens ?? '?'}+${usage.completion_tokens ?? '?'}=${usage.total_tokens ?? '?'}` : '') +
        ')',
    );
    return JSON.parse(content);
  } catch (err: any) {
    const elapsedMs = Date.now() - startedAt;
    logger?.warn?.(`[AgentRuntime] ${label}: model call failed after ${elapsedMs}ms — ${err?.message || err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function clampText(text: string, max = 12000): string {
  return text.length > max ? text.slice(0, max) : text;
}

// ── Section extractors (return null → caller uses heuristic) ─────────────────

export async function modelExtractExperience(
  text: string,
  logger?: MiniLogger,
): Promise<ExtractedEmployment[] | null> {
  if (!shouldUseModel(logger) || !text.trim()) return null;
  const system =
    'You are an expert resume parser. Extract employment history STRICTLY from the supplied text. ' +
    'Never invent employers, titles, or dates. Respond with JSON of the exact shape: ' +
    '{"experience":[{"employerName":string,"jobTitle":string,"startDate":string|null,"endDate":string|null,"location":string|null}]}. ' +
    'Use null for anything not present in the text. If no employment is present, return {"experience":[]}.';
  const json = await chatJson(system, clampText(text), logger, 'experience');
  if (!json || !Array.isArray(json.experience)) return null;
  return json.experience
    .filter((e: any) => e && typeof e.employerName === 'string' && e.employerName.trim())
    .map((e: any) => ({
      employerName: String(e.employerName).trim(),
      jobTitle: e.jobTitle ? String(e.jobTitle).trim() : '',
      startDate: e.startDate ? String(e.startDate) : null,
      endDate: e.endDate ? String(e.endDate) : null,
      location: e.location ? String(e.location) : null,
      description: e.description ? String(e.description) : undefined,
    }));
}

export async function modelExtractSkills(
  text: string,
  logger?: MiniLogger,
): Promise<ExtractedSkill[] | null> {
  if (!shouldUseModel(logger) || !text.trim()) return null;
  const system =
    'You are an expert resume parser. Extract professional and technical skills STRICTLY from the supplied text. ' +
    'Respond with JSON of the exact shape: ' +
    '{"skills":[{"name":string,"proficiency":"beginner"|"intermediate"|"advanced"|"expert"|null,"evidence":string}]}. ' +
    'evidence must be a short snippet copied from the text. If no skills are present, return {"skills":[]}.';
  const json = await chatJson(system, clampText(text), logger, 'skills');
  if (!json || !Array.isArray(json.skills)) return null;
  const allowed = new Set(['beginner', 'intermediate', 'advanced', 'expert']);
  return json.skills
    .filter((s: any) => s && typeof s.name === 'string' && s.name.trim())
    .map((s: any) => ({
      name: String(s.name).trim(),
      proficiency: allowed.has(s.proficiency) ? s.proficiency : undefined,
      evidence: s.evidence ? String(s.evidence) : String(s.name).trim(),
    }));
}

export async function modelExtractEducation(
  text: string,
  logger?: MiniLogger,
): Promise<ExtractedEducationEntry[] | null> {
  if (!shouldUseModel(logger) || !text.trim()) return null;
  const system =
    'You are an expert resume parser. Extract education history STRICTLY from the supplied text. ' +
    'Never invent schools or degrees. Respond with JSON of the exact shape: ' +
    '{"education":[{"schoolName":string,"degree":string|null,"fieldOfStudy":string|null,"startDate":string|null,"endDate":string|null}]}. ' +
    'If no education is present, return {"education":[]}.';
  const json = await chatJson(system, clampText(text), logger, 'education');
  if (!json || !Array.isArray(json.education)) return null;
  const { createHash } = await import('crypto');
  return json.education
    .filter((e: any) => e && typeof e.schoolName === 'string' && e.schoolName.trim())
    .map((e: any) => ({
      id: `edu_${createHash('sha256').update(String(e.schoolName) + '|' + (e.degree ?? '')).digest('hex').slice(0, 12)}`,
      schoolName: String(e.schoolName).trim(),
      degree: e.degree ? String(e.degree).trim() : undefined,
      fieldOfStudy: e.fieldOfStudy ? String(e.fieldOfStudy).trim() : undefined,
      startDate: e.startDate ? String(e.startDate) : null,
      endDate: e.endDate ? String(e.endDate) : null,
      location: e.location ? String(e.location) : null,
      confidence: 0.8,
    }));
}

/** Generate a grounded summary from already-extracted facts. Returns null to fall back. */
export async function modelGenerateSummary(
  facts: { experience: any[]; skills: any[]; education: any[] },
  logger?: MiniLogger,
): Promise<string | null> {
  if (!shouldUseModel(logger)) return null;
  const system =
    'You are an expert resume writer. Write a concise 2-3 sentence professional summary GROUNDED ONLY in the ' +
    'provided structured facts. Do not introduce employers, skills, or claims that are not in the facts. ' +
    'Respond with JSON of the exact shape: {"summary":string}.';
  const json = await chatJson(system, JSON.stringify(facts), logger, 'summary');
  if (!json || typeof json.summary !== 'string' || !json.summary.trim()) return null;
  return json.summary.trim();
}

// ── Comprehensive profile extractor ──────────────────────────────────────────
// Unlike the résumé-section extractors above (which only fire on cleanly
// formatted résumé text), this captures ALL useful facts about a person from
// arbitrary prose — bios, "about" pages, faculty/leadership profiles, etc.

export interface ProfileResult {
  name?: string | null;
  headline?: string | null;          // e.g., "President, The University of Texas at Austin"
  currentTitle?: string | null;
  currentOrganization?: string | null;
  location?: string | null;
  summary?: string | null;            // biographical/about prose, condensed
  experience: ExtractedEmployment[];  // roles found anywhere in the text (incl. prose)
  education: ExtractedEducationEntry[];
  skills: string[];                   // skills / areas of expertise / focus areas
  achievements: string[];             // awards, honors, notable accomplishments
  affiliations: string[];             // boards, memberships, committees, organizations
  links: string[];                    // URLs / social / profile links
}

const EMPTY_PROFILE: ProfileResult = {
  name: null, headline: null, currentTitle: null, currentOrganization: null,
  location: null, summary: null, experience: [], education: [], skills: [],
  achievements: [], affiliations: [], links: [],
};

/** Return an empty profile (used when the model is unavailable). */
export function emptyProfile(): ProfileResult {
  return JSON.parse(JSON.stringify(EMPTY_PROFILE));
}

const asStringList = (v: any): string[] =>
  Array.isArray(v)
    ? v.map((x) => (typeof x === 'string' ? x.trim() : x && typeof x === 'object' ? String(x.name ?? x.title ?? x.value ?? '').trim() : '')).filter(Boolean)
    : [];

/**
 * Extract a complete profile of a person from arbitrary text. Captures résumé
 * data (experience/education/skills) AND general biographical detail
 * (headline, current role, location, achievements, affiliations, links).
 * Returns null when the model is unavailable so callers can fall back.
 */
export async function modelExtractProfile(
  text: string,
  logger?: MiniLogger,
): Promise<ProfileResult | null> {
  if (!shouldUseModel(logger) || !text.trim()) return null;
  const system =
    'You are an expert at building a structured profile of a PERSON from arbitrary web/biographical text ' +
    '(résumés, "about" pages, faculty/leadership bios, news profiles). Extract EVERY useful detail about the ' +
    'person STRICTLY from the supplied text — never invent or infer beyond what is written. Capture both ' +
    'résumé-style data and narrative biographical facts. Respond with JSON of this exact shape:\n' +
    '{"name":string|null,"headline":string|null,"currentTitle":string|null,"currentOrganization":string|null,' +
    '"location":string|null,"summary":string|null,' +
    '"experience":[{"employerName":string,"jobTitle":string,"startDate":string|null,"endDate":string|null,"location":string|null}],' +
    '"education":[{"schoolName":string,"degree":string|null,"fieldOfStudy":string|null,"startDate":string|null,"endDate":string|null}],' +
    '"skills":[string],"achievements":[string],"affiliations":[string],"links":[string]}.\n' +
    'Rules: "summary" is a concise 1-3 sentence bio drawn only from the text. "experience" includes current and ' +
    'past roles described anywhere, including in prose (e.g. "served as dean of ..."). "achievements" are awards, ' +
    'honors, or notable accomplishments. "affiliations" are boards, committees, memberships, or organizations. ' +
    'Use null/[] for anything not present. Do not return placeholder or example data.';
  const json = await chatJson(system, clampText(text), logger, 'profile');
  if (!json || typeof json !== 'object') return null;

  const { createHash } = await import('crypto');
  const experience: ExtractedEmployment[] = (Array.isArray(json.experience) ? json.experience : [])
    .filter((e: any) => e && typeof e.employerName === 'string' && e.employerName.trim())
    .map((e: any) => ({
      employerName: String(e.employerName).trim(),
      jobTitle: e.jobTitle ? String(e.jobTitle).trim() : '',
      startDate: e.startDate ? String(e.startDate) : null,
      endDate: e.endDate ? String(e.endDate) : null,
      location: e.location ? String(e.location) : null,
    }));
  const education: ExtractedEducationEntry[] = (Array.isArray(json.education) ? json.education : [])
    .filter((e: any) => e && typeof e.schoolName === 'string' && e.schoolName.trim())
    .map((e: any) => ({
      id: `edu_${createHash('sha256').update(String(e.schoolName) + '|' + (e.degree ?? '')).digest('hex').slice(0, 12)}`,
      schoolName: String(e.schoolName).trim(),
      degree: e.degree ? String(e.degree).trim() : undefined,
      fieldOfStudy: e.fieldOfStudy ? String(e.fieldOfStudy).trim() : undefined,
      startDate: e.startDate ? String(e.startDate) : null,
      endDate: e.endDate ? String(e.endDate) : null,
      location: null,
      confidence: 0.7,
    }));

  const str = (v: any): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    name: str(json.name),
    headline: str(json.headline),
    currentTitle: str(json.currentTitle),
    currentOrganization: str(json.currentOrganization),
    location: str(json.location),
    summary: str(json.summary),
    experience,
    education,
    skills: asStringList(json.skills),
    achievements: asStringList(json.achievements),
    affiliations: asStringList(json.affiliations),
    links: asStringList(json.links),
  };
}
