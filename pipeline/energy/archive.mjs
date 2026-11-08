// Energy price history: an append-only log of what changed in every plan, day by day.
//
// The AER feed only ever shows plans as they are today, so this archive is the only record of how
// prices moved. It is written defensively, because a false "price change" or "withdrawn" would
// corrupt the history for good:
//  - a plan is a series keyed by its plan ID without the version suffix (AGL1059355MBE4 -> AGL1059355MBE),
//    so a new version of the same plan is a change to that plan, not a withdrawal plus a new plan;
//  - prices are compared in a canonical form (rounded, sorted, names and wording ignored), so
//    reordering, float noise or reworded descriptions never count as changes;
//  - nothing is recorded for a plan whose details weren't read today (prices are never "removed");
//  - a plan is only marked withdrawn after it is missing from two successful reads of its
//    retailer's feed in a row; a failed or partial feed never withdraws anything;
//  - a price change the retailer didn't date (lastUpdated unchanged) is kept but marked unconfirmed;
//  - re-running a day replaces that day's entries instead of adding to them;
//  - before anything is written, the whole log is replayed and must reproduce the new state exactly.
import { mkdir, readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/** Bump when the canonical price form changes: the next run records a "rebase", never price changes. */
export const SIG_VERSION = 1;
const MISSES_TO_WITHDRAW = 2;

export const seriesKey = (id) => {
  const [a, s] = String(id).split('@');
  return a.toUpperCase().replace(/(\D)\d{1,3}$/, '$1') + (s ? `@${s}` : '');
};

// ---- canonical forms
const DROP = new Set(['name', 'desc', 'description', 'displayName', 'terms', 'var', 'onExpiry']);
const KEEP_ORDER = new Set(['blocks']); // step order is meaningful
const r6 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : v);
function canon(v, key = '') {
  if (v === undefined || v === '') return null;
  if (Array.isArray(v)) {
    const out = v.map((x) => canon(x));
    return KEEP_ORDER.has(key) ? out : out.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0));
  }
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) if (!DROP.has(k)) o[k] = canon(v[k], k);
    return o;
  }
  return r6(v);
}
const contract = (c) => (c ? canon({ tp: c.tp || [], cl: c.cl || [], fit: c.fit || [], disc: c.disc || [], fees: c.fees || [] }) : null);
/** Everything that sets what a customer pays. Null when the plan's details weren't read. */
export function priceOf(p) {
  if (!p?.detail) return null;
  const e = contract(p.e);
  const g = contract(p.g);
  const hasTariff = (c) => c && c.tp.length > 0;
  return hasTariff(e) || hasTariff(g) ? { e, g } : null;
}
/** What the plan is: name, type, customers, fuel and where it's offered. */
export const metaOf = (p) => canon({ n: p.n, t: p.t, cu: p.cu, f: p.f, st: p.st || [], d: p.d || [] });
export const hashOf = (o) => createHash('sha1').update(JSON.stringify(o)).digest('hex').slice(0, 16);

export const melbourneDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne' }).format(d);

const readJson = async (p) => {
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch {
    return null;
  }
};
const writeAtomic = async (p, text) => {
  await writeFile(`${p}.tmp`, text);
  await rename(`${p}.tmp`, p);
};
// One plan per line, so each day's change to the state is a small, readable diff
const stateText = (st) => `{"sigVersion":${st.sigVersion},"asOf":${JSON.stringify(st.asOf)},"series":{\n${Object.keys(st.series)
  .sort()
  .map((k) => `${JSON.stringify(k)}:${JSON.stringify(st.series[k])}`)
  .join(',\n')}\n}}\n`;
const eventsFile = (dir, date) => join(dir, 'events', date.slice(0, 4), `${date}.jsonl`);

/**
 * Work out today's events and the new state. Pure: no files.
 * @param base     state before today: { sigVersion, asOf, series: { key: entry } }
 * @param plans    today's normalised plans
 * @param listed   Map planId -> feed base, for every plan in today's lists
 * @param feedOk   Map feed base -> true when that feed was read completely today
 */
export function step(base, plans, listed, feedOk, date) {
  const prevSeries = base?.series || {};
  const series = structuredClone(prevSeries);
  const events = [];
  const rebase = !!base && base.sigVersion !== SIG_VERSION && Object.keys(prevSeries).length > 0;
  const stats = { listed: 0, priced: 0, new: 0, price: 0, unconfirmed: 0, meta: 0, ver: 0, gone: 0, back: 0, rebase: 0, collisions: 0 };

  // Today's plans by series key (plans listed twice under one key keep their full ID as key)
  const byKey = new Map();
  for (const p of plans) {
    if (!listed.has(p.id)) continue;
    const k = seriesKey(p.id);
    (byKey.get(k) || byKey.set(k, []).get(k)).push(p);
  }
  const today = new Map();
  for (const [k, list] of byKey) {
    if (list.length === 1) today.set(k, list[0]);
    else for (const p of list) today.set(p.id.toUpperCase(), p), stats.collisions++;
  }

  for (const [k, p] of [...today.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    stats.listed++;
    const price = priceOf(p);
    const meta = metaOf(p);
    const ps = price ? hashOf(price) : null;
    const ms = hashOf(meta);
    if (price) stats.priced++;
    const s = series[k];
    const feed = listed.get(p.id);
    if (!s) {
      series[k] = { id: p.id, b: p.b, feed, ps, ms, up: p.up || null, first: price ? date : null, seen: date, miss: 0, gone: false };
      if (price) events.push({ d: date, k, id: p.id, b: p.b, ev: 'new', up: p.up || null, m: meta, p: price }), stats.new++;
      continue;
    }
    Object.assign(s, { seen: date, miss: 0, feed, b: p.b });
    if (s.gone) {
      s.gone = false;
      const changed = price && ps !== s.ps;
      events.push({ d: date, k, id: p.id, ev: 'back', ...(p.id !== s.id ? { from: s.id } : {}), up: p.up || null, ...(changed ? { p: price } : {}) }), stats.back++;
      if (changed) s.ps = ps;
      Object.assign(s, { id: p.id, up: p.up || null });
    }
    if (rebase && price) {
      events.push({ d: date, k, id: p.id, ev: 'rebase', p: price }), stats.rebase++;
      Object.assign(s, { ps, id: p.id, up: p.up || null });
    } else if (price && s.ps === null) {
      events.push({ d: date, k, id: p.id, b: p.b, ev: 'new', up: p.up || null, m: meta, p: price }), stats.new++;
      Object.assign(s, { ps, first: date, id: p.id, up: p.up || null });
    } else if (price && ps !== s.ps) {
      // The retailer should date a change; one it didn't is kept but marked for review
      const confirmed = (p.up || null) !== s.up || p.id !== s.id;
      events.push({ d: date, k, id: p.id, ev: 'price', ...(p.id !== s.id ? { from: s.id } : {}), up: p.up || null, ...(confirmed ? {} : { q: 'unconfirmed' }), p: price });
      stats.price++;
      if (!confirmed) stats.unconfirmed++;
      Object.assign(s, { ps, id: p.id, up: p.up || null });
    } else if (price && p.id !== s.id) {
      events.push({ d: date, k, id: p.id, ev: 'ver', from: s.id }), stats.ver++;
      Object.assign(s, { id: p.id, up: p.up || null });
    } else if (price) s.up = p.up || null;
    if (ms !== s.ms) {
      if (s.ms) events.push({ d: date, k, id: p.id, ev: 'meta', m: meta }), stats.meta++;
      s.ms = ms;
    }
  }

  // Plans not listed today: only a complete read of their retailer's feed counts as "missing"
  for (const k of Object.keys(series).sort()) {
    const s = series[k];
    if (today.has(k) || s.gone) continue;
    if (feedOk.get(s.feed) !== true) continue;
    s.miss = (s.miss || 0) + 1;
    if (s.miss >= MISSES_TO_WITHDRAW && s.ps !== null) {
      s.gone = true;
      events.push({ d: date, k, id: s.id, ev: 'gone', last: s.seen }), stats.gone++;
    }
  }
  return { state: { sigVersion: SIG_VERSION, asOf: date, series }, events, stats };
}

/** Rebuild prices, IDs and withdrawals from the event log alone. */
export function replay(allEvents) {
  const out = {};
  for (const e of allEvents) {
    const s = (out[e.k] ??= { ps: null, id: null, gone: false });
    if (e.p) s.ps = hashOf(e.p);
    if (e.id) s.id = e.id;
    if (e.ev === 'gone') s.gone = true;
    if (e.ev === 'back') s.gone = false;
  }
  return out;
}

async function allEvents(dir, upTo) {
  const files = [];
  try {
    for (const y of (await readdir(join(dir, 'events'))).sort()) for (const f of (await readdir(join(dir, 'events', y))).sort()) if (f.endsWith('.jsonl') && f.slice(0, 10) < upTo) files.push(join(dir, 'events', y, f));
  } catch {}
  const out = [];
  for (const f of files)
    for (const line of (await readFile(f, 'utf8')).split('\n'))
      if (line.trim()) out.push(JSON.parse(line));
  return out;
}

/**
 * Record today's prices in the archive at `dir`. Throws (and writes nothing) if the result
 * doesn't replay exactly.
 */
export async function recordDay({ dir, plans, listed, feedOk, date = melbourneDate(), log = () => {} }) {
  await mkdir(join(dir, 'events', date.slice(0, 4)), { recursive: true });
  await mkdir(join(dir, 'runs'), { recursive: true });
  const current = await readJson(join(dir, 'state.json'));
  // A missing state with a log already present means the archive wasn't restored properly:
  // starting again would re-record every plan as new, so stop instead
  if (!current && (await allEvents(dir, '9999')).length) throw new Error('state.json is missing but the archive has events; not starting a new history over the old one');
  // Re-running a day starts again from the state before that day
  let base = current;
  if (current?.asOf === date) base = await readJson(join(dir, 'state.prev.json'));
  else if (current?.asOf && current.asOf > date) throw new Error(`archive is already at ${current.asOf}, later than ${date}`);

  const { state, events, stats } = step(base, plans, listed, feedOk, date);

  // Integrity: the log up to yesterday plus today's events must reproduce the new state
  const derived = replay([...(await allEvents(dir, date)), ...events]);
  const bad = [];
  for (const [k, s] of Object.entries(state.series)) {
    if (s.ps === null) continue;
    const d = derived[k];
    if (!d || d.ps !== s.ps || d.gone !== s.gone || d.id !== s.id) bad.push(k);
  }
  if (bad.length) throw new Error(`archive check failed for ${bad.length} plans (e.g. ${bad.slice(0, 3).join(', ')}); nothing written`);

  // Large one-day moves happen (e.g. the 1 July price reset) but are worth a second look
  const flag = stats.priced && stats.price / stats.priced > 0.25 && !/-(06-2[5-9]|06-30|07-0\d|07-10)$/.test(date) ? 'review: over a quarter of plans changed price today' : null;
  const run = { date, sigVersion: SIG_VERSION, at: new Date().toISOString(), ...stats, series: Object.keys(state.series).length, flag };

  await writeAtomic(eventsFile(dir, date), events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
  await writeAtomic(join(dir, 'runs', `${date}.json`), JSON.stringify(run, null, 1));
  if (base) await writeAtomic(join(dir, 'state.prev.json'), stateText(base));
  await writeAtomic(join(dir, 'state.json'), stateText(state));
  await writeAtomic(join(dir, 'README.md'), README);
  log(`Price history ${date}: ${stats.new} new, ${stats.price} price changes${stats.unconfirmed ? ` (${stats.unconfirmed} unconfirmed)` : ''}, ${stats.ver} new versions without price changes, ${stats.meta} other changes, ${stats.gone} withdrawn, ${stats.back} back${stats.rebase ? `, ${stats.rebase} rebased` : ''}${flag ? ` — ${flag}` : ''}`);
  return run;
}

/** A small public summary of the archive for the site: how long it has run and recent activity. */
export async function historySummary(dir) {
  let days = [];
  try {
    days = (await readdir(join(dir, 'runs'))).filter((f) => f.endsWith('.json')).sort();
  } catch {}
  if (!days.length) return null;
  const runs = [];
  for (const f of days.slice(-30)) runs.push(await readJson(join(dir, 'runs', f)));
  const since = days[0].slice(0, 10);
  // the first day records every plan as new, which isn't market activity
  const sum = (k) => runs.reduce((a, r) => a + (r && !(k === 'new' && r.date === since) ? r[k] || 0 : 0), 0);
  const last = runs[runs.length - 1];
  return { since, days: days.length, plans: last.series, last30: { price: sum('price'), new: sum('new'), gone: sum('gone') } };
}

const README = `# OpenCompare energy price history

A day-by-day record of every energy plan published under the Consumer Data Right (AER feed), kept
by the OpenCompare daily job. Written by \`pipeline/energy/archive.mjs\`; don't edit by hand.

- \`events/YYYY/YYYY-MM-DD.jsonl\`: one line per change on that day (Melbourne date):
  - \`new\`: first day the plan was recorded with prices (\`p\` = prices, \`m\` = name, type, area)
  - \`price\`: prices changed (\`p\` = new prices; \`from\` = previous plan ID if the version changed;
    \`q: "unconfirmed"\` = the retailer didn't update the plan's lastUpdated date, so worth checking)
  - \`ver\`: new plan version, prices unchanged
  - \`meta\`: name, type, customers or areas changed
  - \`gone\`: withdrawn (missing from two complete reads of the retailer's feed in a row; \`last\` = last day seen)
  - \`back\`: relisted after being withdrawn (\`p\` only if prices differ)
  - \`rebase\`: prices re-recorded after a change to how prices are compared (not a market change)
- \`k\` is the plan's series key: its plan ID without the version suffix (AGL1059355MBE4 → AGL1059355MBE).
- Prices (\`p\`) are in dollars excluding GST, as published: \`e\` electricity and \`g\` gas, each with
  tariff periods (\`tp\`), controlled load (\`cl\`), feed-in tariffs (\`fit\`), discounts (\`disc\`) and fees.
- \`state.json\`: where every plan stands now (for the next day's comparison); \`state.prev.json\` the day before.
- \`runs/YYYY-MM-DD.json\`: what each day's run saw and recorded.

Every run replays the whole log and refuses to write if the result doesn't match the state exactly.
`;
