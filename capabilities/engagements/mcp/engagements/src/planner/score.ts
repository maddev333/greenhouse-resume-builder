/**
 * Suggestion scoring — the transparent, tunable math the planner "shows".
 *   suggestionScore(active)   = stalenessNorm × valueNorm × topicRelevance
 *   suggestionScore(prospect) = valueNorm × topicRelevance        (no staleness — the "initiate" path)
 * See `engagement-intelligence/MVP-PLAN.md` §5.1 and `ARCHITECTURE.md` §6.
 */
import type { Contact } from '@greenhouse-resume-builder/shared';
import { DEFAULT_WEIGHTS, PlannerWeights } from './weights';
import { daysBetween } from './clock';
import type { ScoreFactors } from './types';

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/** strategicValue (1–5) → [0.2, 1.0]. */
export function valueNorm(strategicValue: number): number {
  return clamp01(strategicValue / 5);
}

/**
 * Recency → [0, 1]: 0 when just interacted (or no history), rising linearly to 1.0 at
 * `stalenessSpanDays`. A fresh contact scores ~0, so the cooldown falls out naturally — a
 * just-met relationship is not re-recommended (ARCHITECTURE §16.4).
 */
export function stalenessNorm(
  lastInteractionDate: string | undefined,
  today: string,
  w: PlannerWeights = DEFAULT_WEIGHTS,
): number {
  if (!lastInteractionDate) return 0; // prospects: no staleness signal
  const days = daysBetween(lastInteractionDate, today); // today − lastInteraction
  if (days <= 0) return 0;
  return clamp01(days / w.stalenessSpanDays);
}

/** Topic fit: 1.0 when the contact shares any target topic, 0.5 when no target given, 0.2 on a miss. */
export function topicRelevance(contactTopicIds: string[], targetTopicIds?: string[]): number {
  if (!targetTopicIds || targetTopicIds.length === 0) return 0.5;
  const target = new Set(targetTopicIds);
  return contactTopicIds.some((t) => target.has(t)) ? 1.0 : 0.2;
}

export interface ScoredSuggestion {
  score: number;
  factors: ScoreFactors;
}

/** Full suggestion score for one contact against a set of target topics. */
export function suggestionScore(
  contact: Contact,
  targetTopicIds: string[] | undefined,
  today: string,
  w: PlannerWeights = DEFAULT_WEIGHTS,
): ScoredSuggestion {
  const valN = valueNorm(contact.strategicValue);
  const topic = topicRelevance(contact.topicIds ?? [], targetTopicIds);

  if (contact.status === 'prospect') {
    const factors: ScoreFactors = { stalenessNorm: 0, valueNorm: valN, topicRelevance: topic };
    return { score: valN * topic, factors };
  }

  const staleN = stalenessNorm(contact.lastInteractionDate, today, w);
  const factors: ScoreFactors = { stalenessNorm: staleN, valueNorm: valN, topicRelevance: topic };
  return { score: staleN * valN * topic, factors };
}
