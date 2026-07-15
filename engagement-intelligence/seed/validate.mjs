#!/usr/bin/env node
/**
 * Dependency-free integrity validator for the staged seed data.
 * Usage:  node validate.mjs
 * Exits 0 when clean, 1 when any error is found.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig, demoToday, staleCutoff, shiftDateByMonths } from './clock.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const CFG = loadConfig();
const SHIFT = CFG.shiftMonths || 0;
const TODAY = demoToday(CFG); // authored `today` shifted by SHIFT
const STALE_CUTOFF = staleCutoff(CFG); // TODAY - staleCutoffDays

const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

const load = (f) => {
  try {
    return JSON.parse(readFileSync(join(DIR, f), 'utf8'));
  } catch (e) {
    err(`Cannot read/parse ${f}: ${e.message}`);
    return [];
  }
};

const topics = load('topics.json');
const messages = load('messages.json');
const leaders = load('leaders.json');
const contacts = load('contacts.json');
const events = load('events.json');
const engagements = load('engagements.json');
const afteractions = load('afteractions.json');

const DOMAINS = new Set(['technical', 'non-technical']);
const LEVELS = new Set(['L1', 'L2', 'L3', 'L4']);
const ISO = /^\d{4}-\d{2}-\d{2}$/;

// ── ID uniqueness (global) ───────────────────────────────────────────────
const seen = new Map();
const collect = (arr, kind) => {
  for (const r of arr) {
    if (!r || typeof r.id !== 'string' || !r.id) {
      err(`${kind}: record missing string id`);
      continue;
    }
    if (seen.has(r.id)) err(`Duplicate id "${r.id}" (${kind} and ${seen.get(r.id)})`);
    else seen.set(r.id, kind);
  }
};
collect(topics, 'topic');
collect(messages, 'message');
collect(leaders, 'leader');
collect(contacts, 'contact');
collect(events, 'event');
collect(engagements, 'engagement');
collect(afteractions, 'afteraction');

const has = (arr, id) => arr.some((r) => r.id === id);
const topicIds = new Set(topics.map((t) => t.id));
const msgIds = new Set(messages.map((m) => m.id));
const leaderIds = new Set(leaders.map((l) => l.id));
const contactIds = new Set(contacts.map((c) => c.id));
const engagementIds = new Set(engagements.map((e) => e.id));

const geoOk = (g, ctx) => {
  if (!g || typeof g !== 'object') return err(`${ctx}: missing geo point`);
  if (typeof g.city !== 'string' || !g.city) err(`${ctx}: geo.city missing`);
  if (typeof g.lat !== 'number' || Number.isNaN(g.lat)) err(`${ctx}: geo.lat not numeric`);
  if (typeof g.lng !== 'number' || Number.isNaN(g.lng)) err(`${ctx}: geo.lng not numeric`);
};
const dateOk = (d, ctx) => {
  if (typeof d !== 'string' || !ISO.test(d)) err(`${ctx}: date "${d}" not ISO YYYY-MM-DD`);
};

// ── Topics ───────────────────────────────────────────────────────────────
for (const t of topics) {
  if (!DOMAINS.has(t.domain)) err(`topic ${t.id}: bad domain "${t.domain}"`);
  if (t.approvedMessageId != null && !msgIds.has(t.approvedMessageId))
    err(`topic ${t.id}: approvedMessageId "${t.approvedMessageId}" not found`);
}

// ── Messages ───────────────────────────────────────────────────────────────
for (const m of messages) {
  if (!topicIds.has(m.topicId)) err(`message ${m.id}: topicId "${m.topicId}" not found`);
  if (!Number.isInteger(m.version) || m.version < 1) err(`message ${m.id}: bad version`);
  if (!['draft', 'approved'].includes(m.status)) err(`message ${m.id}: bad status`);
  if (!Array.isArray(m.intendedPoints) || m.intendedPoints.length === 0)
    err(`message ${m.id}: intendedPoints empty`);
  if (m.effectiveFrom) dateOk(m.effectiveFrom, `message ${m.id}.effectiveFrom`);
}
// approvedMessageId must reference a message whose topic matches
for (const t of topics) {
  if (t.approvedMessageId) {
    const m = messages.find((x) => x.id === t.approvedMessageId);
    if (m && m.topicId !== t.id)
      err(`topic ${t.id}: approvedMessageId ${m.id} belongs to topic ${m.topicId}`);
  }
}

// ── Leaders ───────────────────────────────────────────────────────────────
for (const l of leaders) {
  if (!DOMAINS.has(l.domain)) err(`leader ${l.id}: bad domain "${l.domain}"`);
  if (!LEVELS.has(l.level)) err(`leader ${l.id}: bad level "${l.level}"`);
  geoOk(l.homeBase, `leader ${l.id}.homeBase`);
  if (!Array.isArray(l.availability) || l.availability.length === 0)
    err(`leader ${l.id}: availability empty`);
  else
    for (const [i, w] of l.availability.entries()) {
      dateOk(w.start, `leader ${l.id}.availability[${i}].start`);
      dateOk(w.end, `leader ${l.id}.availability[${i}].end`);
      if (ISO.test(w.start) && ISO.test(w.end) && w.end < w.start)
        err(`leader ${l.id}: availability[${i}] end<start`);
    }
  if (typeof l.daysAwayBudget !== 'number' || l.daysAwayBudget <= 0)
    err(`leader ${l.id}: bad daysAwayBudget`);
}

// ── Contacts (incl. prospects) ─────────────────────────────────────────────
let staleCount = 0,
  freshCount = 0,
  prospectCount = 0;
for (const c of contacts) {
  if (!DOMAINS.has(c.domain)) err(`contact ${c.id}: bad domain "${c.domain}"`);
  if (!['individual', 'company', 'org'].includes(c.type)) err(`contact ${c.id}: bad type`);
  if (!['active', 'prospect'].includes(c.status)) err(`contact ${c.id}: bad status`);
  if (!Number.isInteger(c.strategicValue) || c.strategicValue < 1 || c.strategicValue > 5)
    err(`contact ${c.id}: strategicValue out of 1..5`);
  geoOk(c.location, `contact ${c.id}.location`);
  if (c.level != null && !LEVELS.has(c.level)) err(`contact ${c.id}: bad level "${c.level}"`);
  for (const tid of c.topicIds || []) if (!topicIds.has(tid)) err(`contact ${c.id}: topicId "${tid}" not found`);
  for (const lid of c.relationshipOwnerLeaderIds || [])
    if (!leaderIds.has(lid)) err(`contact ${c.id}: owner leader "${lid}" not found`);

  if (c.status === 'prospect') {
    prospectCount++;
    if (c.lastInteractionDate != null)
      err(`contact ${c.id}: prospect must NOT have lastInteractionDate`);
    if (c.relationshipOwnerLeaderIds && c.relationshipOwnerLeaderIds.length > 0)
      warn(`contact ${c.id}: prospect has a relationship owner (expected none)`);
  } else {
    if (c.lastInteractionDate == null)
      err(`contact ${c.id}: active contact missing lastInteractionDate`);
    else {
      dateOk(c.lastInteractionDate, `contact ${c.id}.lastInteractionDate`);
      const li = shiftDateByMonths(c.lastInteractionDate, SHIFT);
      if (li < STALE_CUTOFF) staleCount++;
      else freshCount++;
    }
  }
}

// ── Events ───────────────────────────────────────────────────────────────
for (const e of events) {
  if (!['conference', 'convention', 'function'].includes(e.type)) err(`event ${e.id}: bad type`);
  geoOk(e.location, `event ${e.id}.location`);
  dateOk(e.start, `event ${e.id}.start`);
  dateOk(e.end, `event ${e.id}.end`);
  if (ISO.test(e.start) && ISO.test(e.end) && e.end < e.start) err(`event ${e.id}: end<start`);
  for (const tid of e.topicIds || []) if (!topicIds.has(tid)) err(`event ${e.id}: topicId "${tid}" not found`);
  for (const cid of e.attendingContactIds || []) {
    if (!contactIds.has(cid)) err(`event ${e.id}: attendee "${cid}" not found`);
    else {
      const c = contacts.find((x) => x.id === cid);
      if (c.status !== 'active') err(`event ${e.id}: attendee "${cid}" is not an active contact`);
    }
  }
  for (const pid of e.exhibitorProspectIds || []) {
    if (!contactIds.has(pid)) err(`event ${e.id}: prospect "${pid}" not found`);
    else {
      const c = contacts.find((x) => x.id === pid);
      if (c.status !== 'prospect') err(`event ${e.id}: exhibitor "${pid}" is not a prospect`);
    }
  }
}

// ── Engagements ────────────────────────────────────────────────────────────
for (const g of engagements) {
  if (!contactIds.has(g.contactId)) err(`engagement ${g.id}: contactId "${g.contactId}" not found`);
  if (!Array.isArray(g.leaderIds) || g.leaderIds.length === 0)
    err(`engagement ${g.id}: leaderIds empty`);
  for (const lid of g.leaderIds || []) if (!leaderIds.has(lid)) err(`engagement ${g.id}: leader "${lid}" not found`);
  if (g.topicId && !topicIds.has(g.topicId)) err(`engagement ${g.id}: topicId "${g.topicId}" not found`);
  if (g.intendedMessageId && !msgIds.has(g.intendedMessageId))
    err(`engagement ${g.id}: intendedMessageId "${g.intendedMessageId}" not found`);
  dateOk(g.date, `engagement ${g.id}.date`);
  if (!['scheduled', 'held', 'followup'].includes(g.status)) err(`engagement ${g.id}: bad status`);
  for (const aid of g.afterActionNoteIds || [])
    if (!has(afteractions, aid)) err(`engagement ${g.id}: afterActionNoteId "${aid}" not found`);
}

// ── After-action notes ─────────────────────────────────────────────────────
for (const a of afteractions) {
  if (!engagementIds.has(a.engagementId))
    err(`afteraction ${a.id}: engagementId "${a.engagementId}" not found`);
  if (!a.extractedSummary) err(`afteraction ${a.id}: extractedSummary empty`);
  if (!Array.isArray(a.actualMessagePoints) || a.actualMessagePoints.length === 0)
    err(`afteraction ${a.id}: actualMessagePoints empty`);
  if (a.ingestedVia && !['document-intelligence', 'seed'].includes(a.ingestedVia))
    err(`afteraction ${a.id}: bad ingestedVia "${a.ingestedVia}"`);
}
// Back-link symmetry: each note's engagement should list it
for (const a of afteractions) {
  const g = engagements.find((x) => x.id === a.engagementId);
  if (g && !(g.afterActionNoteIds || []).includes(a.id))
    warn(`afteraction ${a.id}: engagement ${g.id} does not back-reference it`);
}

// ── Report ─────────────────────────────────────────────────────────────────
const counts = {
  topics: topics.length,
  messages: messages.length,
  leaders: leaders.length,
  contacts: contacts.length,
  '  active': contacts.filter((c) => c.status === 'active').length,
  '  prospects': prospectCount,
  events: events.length,
  engagements: engagements.length,
  afteractions: afteractions.length,
};
console.log('── Seed integrity report ──────────────────────────────');
for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(14)} ${v}`);
console.log(
  `\n  Demo clock: today ${TODAY} (authored ${CFG.today}, shiftMonths ${SHIFT}); stale cutoff ${STALE_CUTOFF} (${CFG.staleCutoffDays ?? 180}d)`,
);
console.log(`  Staleness: ${staleCount} stale / ${freshCount} fresh active contacts`);

if (warnings.length) {
  console.log(`\n⚠  ${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`   - ${w}`);
}
if (errors.length) {
  console.error(`\n✖  ${errors.length} error(s):`);
  for (const e of errors) console.error(`   - ${e}`);
  process.exit(1);
}
console.log('\n✔  All integrity checks passed.');
