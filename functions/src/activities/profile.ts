/**
 * ExtractProfile: comprehensive person-profile extraction.
 *
 * Runs the model-backed `modelExtractProfile` over the FULL normalized text
 * (not section-routed), so biographical pages — "about" pages, leadership/faculty
 * bios, news profiles — yield rich facts even when they are not formatted as a
 * résumé. Falls back to an empty profile when the model is unavailable, leaving
 * the deterministic section extractors as the sole source of facts.
 */

import { app } from 'durable-functions';
import { actx, modelExtractProfile, emptyProfile, type ProfileResult } from '../services/agent-runtime';

export type { ProfileResult } from '../services/agent-runtime';

export async function extractProfile(
  context: any,
  input: { runId?: string; textBlocks?: string[] },
): Promise<ProfileResult> {
  const textBlocks = input?.textBlocks ?? [];
  const fullText = textBlocks.join('\n').trim();

  if (!fullText) {
    context.logger.info('[Profile] No text to analyze.');
    return emptyProfile();
  }

  const result = await modelExtractProfile(fullText, context.logger);
  if (!result) {
    context.logger.info('[Profile] Model unavailable — skipping profile extraction.');
    return emptyProfile();
  }

  context.logger.info(
    `[Profile] Extracted: name=${result.name ?? '—'} role=${result.currentTitle ?? '—'} ` +
      `exp=${result.experience.length} edu=${result.education.length} skills=${result.skills.length} ` +
      `achievements=${result.achievements.length} affiliations=${result.affiliations.length} links=${result.links.length}`,
  );
  return result;
}

app.activity('ExtractProfile', {
  handler: (input: any, context: any) => extractProfile(actx(context), input),
});
