#!/usr/bin/env node
// Tests for the price-history archive. Run: node scripts/test-archive.mjs
// Each case is a trap the archive must not fall into (false changes, false withdrawals, double counting).
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, recordDay, seriesKey, priceOf, replay, historySummary } from '../pipeline/energy/archive.mjs';
import { unlink } from 'node:fs/promises';

const plan = (id, o = {}) => ({
  id,
  b: o.b ?? 'sparky',
  n: o.n ?? `Plan ${seriesKey(id)}`,
  t: 'MARKET',
  cu: 'RESIDENTIAL',
  f: 'ELECTRICITY',
  st: ['NSW'],
  d: ['Ausgrid'],
  up: o.up ?? '2026-10-01T00:00:00Z',
  detail: o.detail ?? true,
  e: o.e ?? {
    tp: [
      { name: 'Summer', sd: '12-01', ed: '02-28', sup: o.sup ?? 1.1, kind: 'single', blocks: [{ p: o.rate ?? 0.3, v: 1000, u: 'KWH' }, { p: 0.35, v: null, u: 'KWH' }], per: 'P1D' },
      { name: 'Rest', sd: '03-01', ed: '11-30', sup: o.sup ?? 1.1, kind: 'single', blocks: [{ p: 0.28, v: null, u: 'KWH' }], per: 'P1D' },
    ],
    fit: [{ name: 'FiT', kind: 'single', blocks: [{ p: o.fit ?? 0.05, v: null, u: 'KWH' }] }],
    disc: [],
    fees: [{ type: 'EXIT', amt: 0, desc: 'No exit fee' }],
  },
});
const listedOf = (plans, feed = 'f1') => new Map(plans.map((p) => [p.id, feed]));
const ok = new Map([['f1', true]]);
const failed = new Map([['f1', false]]);
const evs = (r) => r.events.map((e) => `${e.ev}:${e.k}`).sort();
let n = 0;
const test = async (name, fn) => {
  await fn();
  n++;
  console.log(`  ok  ${name}`);
};

console.log('Price history archive');

await test('series key drops the version suffix but keeps the source', () => {
  assert.equal(seriesKey('AGL1059355MBE4@EME'), 'AGL1059355MBE@EME');
  assert.equal(seriesKey('AGL1059355MBE12@EME'), 'AGL1059355MBE@EME');
  assert.equal(seriesKey('AMB798770MR@VEC'), 'AMB798770MR@VEC');
  assert.equal(seriesKey('1ST1213185MRE1'), '1ST1213185MRE');
});

await test('first day: every priced plan is new; unpriced plans record nothing', () => {
  const ps = [plan('A1E1'), plan('B1E1'), plan('C1E1', { detail: false })];
  const r = step(null, ps, listedOf(ps), ok, '2026-11-07');
  assert.deepEqual(evs(r), ['new:A1E', 'new:B1E']);
});

await test('identical data next day: no events', () => {
  const ps = [plan('A1E1'), plan('B1E1')];
  const d1 = step(null, ps, listedOf(ps), ok, '2026-11-07');
  const d2 = step(d1.state, ps, listedOf(ps), ok, '2026-11-08');
  assert.deepEqual(d2.events, []);
});

await test('reordering, float noise, renamed periods and reworded text are not changes', () => {
  const a = plan('A1E1');
  const b = structuredClone(a);
  b.e.tp.reverse();
  b.e.tp[0].name = 'Off season';
  b.e.tp[0].sup = 1.1 + 1e-12;
  b.e.fees[0].desc = 'There is no exit fee';
  b.n = a.n; // same plan name
  const d1 = step(null, [a], listedOf([a]), ok, '2026-11-07');
  const d2 = step(d1.state, [b], listedOf([b]), ok, '2026-11-08');
  assert.deepEqual(d2.events, []);
});

await test('block order is meaningful: swapping step prices is a change', () => {
  const a = plan('A1E1');
  const b = structuredClone(a);
  b.e.tp[0].blocks = [{ p: 0.35, v: 1000, u: 'KWH' }, { p: 0.3, v: null, u: 'KWH' }];
  b.up = '2026-11-08T00:00:00Z';
  const d1 = step(null, [a], listedOf([a]), ok, '2026-11-07');
  assert.deepEqual(evs(step(d1.state, [b], listedOf([b]), ok, '2026-11-08')), ['price:A1E']);
});

await test('a dated price change is recorded once, as confirmed', () => {
  const d1 = step(null, [plan('A1E1')], listedOf([plan('A1E1')]), ok, '2026-11-07');
  const p2 = plan('A1E1', { rate: 0.32, up: '2026-11-08T00:00:00Z' });
  const d2 = step(d1.state, [p2], listedOf([p2]), ok, '2026-11-08');
  assert.deepEqual(evs(d2), ['price:A1E']);
  assert.equal(d2.events[0].q, undefined);
  assert.deepEqual(step(d2.state, [p2], listedOf([p2]), ok, '2026-11-09').events, []);
});

await test('an undated price change is kept but marked unconfirmed', () => {
  const d1 = step(null, [plan('A1E1')], listedOf([plan('A1E1')]), ok, '2026-11-07');
  const p2 = plan('A1E1', { rate: 0.32 }); // same lastUpdated
  const d2 = step(d1.state, [p2], listedOf([p2]), ok, '2026-11-08');
  assert.equal(d2.events[0].q, 'unconfirmed');
  assert.equal(d2.stats.unconfirmed, 1);
});

await test('a new version of a plan is a change to the same plan, not withdrawn + new', () => {
  const d1 = step(null, [plan('AGL1059355MBE4@EME')], listedOf([plan('AGL1059355MBE4@EME')]), ok, '2026-11-07');
  const v5 = plan('AGL1059355MBE5@EME', { rate: 0.31 });
  const d2 = step(d1.state, [v5], listedOf([v5]), ok, '2026-11-08');
  assert.deepEqual(evs(d2), ['price:AGL1059355MBE@EME']);
  assert.equal(d2.events[0].from, 'AGL1059355MBE4@EME');
  const v6 = plan('AGL1059355MBE6@EME', { rate: 0.31 });
  assert.deepEqual(evs(step(d2.state, [v6], listedOf([v6]), ok, '2026-11-09')), ['ver:AGL1059355MBE@EME']);
});

await test('details not read today (deferred or failed): no event, prices never "removed"', () => {
  const d1 = step(null, [plan('A1E1')], listedOf([plan('A1E1')]), ok, '2026-11-07');
  const listOnly = plan('A1E1', { detail: false });
  const d2 = step(d1.state, [listOnly], listedOf([listOnly]), ok, '2026-11-08');
  assert.deepEqual(d2.events, []);
  assert.equal(d2.state.series['A1E'].ps, d1.state.series['A1E'].ps);
});

await test('missing once is not withdrawn; missing twice in a row is', () => {
  const ps = [plan('A1E1'), plan('B1E1')];
  const d1 = step(null, ps, listedOf(ps), ok, '2026-11-07');
  const d2 = step(d1.state, [ps[0]], listedOf([ps[0]]), ok, '2026-11-08');
  assert.deepEqual(d2.events, []);
  const d3 = step(d2.state, [ps[0]], listedOf([ps[0]]), ok, '2026-11-09');
  assert.deepEqual(evs(d3), ['gone:B1E']);
  assert.equal(d3.events[0].last, '2026-11-07');
});

await test('a blip (missing one day, back the next) records nothing', () => {
  const ps = [plan('A1E1'), plan('B1E1')];
  const d1 = step(null, ps, listedOf(ps), ok, '2026-11-07');
  const d2 = step(d1.state, [ps[0]], listedOf([ps[0]]), ok, '2026-11-08');
  const d3 = step(d2.state, ps, listedOf(ps), ok, '2026-11-09');
  assert.deepEqual(d3.events, []);
  assert.equal(d3.state.series['B1E'].miss, 0);
});

await test('a failed feed never withdraws its plans, however long it is down', () => {
  const ps = [plan('A1E1')];
  let s = step(null, ps, listedOf(ps), ok, '2026-11-07').state;
  for (const d of ['2026-11-08', '2026-11-09', '2026-11-10']) {
    const r = step(s, [], new Map(), failed, d);
    assert.deepEqual(r.events, []);
    s = r.state;
  }
  assert.equal(s.series['A1E'].gone, false);
});

await test('a retailer left out of the run (feed not read at all) is untouched', () => {
  const ps = [plan('A1E1')];
  let s = step(null, ps, listedOf(ps), ok, '2026-11-07').state;
  for (const d of ['2026-11-08', '2026-11-09']) s = step(s, [], new Map(), new Map(), d).state;
  assert.equal(s.series['A1E'].gone, false);
});

await test('withdrawn then relisted: "back", with prices only if they changed', () => {
  const ps = [plan('A1E1'), plan('B1E1')];
  let s = step(null, ps, listedOf(ps), ok, '2026-11-07').state;
  s = step(s, [ps[0]], listedOf([ps[0]]), ok, '2026-11-08').state;
  s = step(s, [ps[0]], listedOf([ps[0]]), ok, '2026-11-09').state;
  const r = step(s, ps, listedOf(ps), ok, '2026-11-10');
  assert.deepEqual(evs(r), ['back:B1E']);
  assert.equal(r.events[0].p, undefined);
});

await test('brand ID tidy-ups (e.g. "amber " to "amber") are not changes', () => {
  const a = plan('A1E1', { b: 'amber ' });
  const b = plan('A1E1', { b: 'amber' });
  const d1 = step(null, [a], listedOf([a]), ok, '2026-11-07');
  assert.deepEqual(step(d1.state, [b], listedOf([b]), ok, '2026-11-08').events, []);
});

await test('a plan renamed or moved between areas is a "meta" change, not a price change', () => {
  const a = plan('A1E1');
  const b = { ...plan('A1E1'), n: 'Renamed plan', d: ['Ausgrid', 'Endeavour'] };
  const d1 = step(null, [a], listedOf([a]), ok, '2026-11-07');
  assert.deepEqual(evs(step(d1.state, [b], listedOf([b]), ok, '2026-11-08')), ['meta:A1E']);
});

await test('replaying the log reproduces the state', () => {
  const days = [
    [plan('A1E1'), plan('B1E1'), plan('C1E1')],
    [plan('A1E2', { rate: 0.4 }), plan('B1E1')],
    [plan('A1E2', { rate: 0.4 }), plan('B1E1', { fit: 0.06, up: 'x' })],
    [plan('A1E2', { rate: 0.4 }), plan('B1E1', { fit: 0.06, up: 'x' }), plan('C1E1')],
  ];
  let s = null;
  const all = [];
  days.forEach((ps, i) => {
    const r = step(s, ps, listedOf(ps), ok, `2026-11-0${i + 7}`);
    all.push(...r.events);
    s = r.state;
  });
  const d = replay(all);
  for (const [k, v] of Object.entries(s.series)) assert.deepEqual([d[k].ps, d[k].id, d[k].gone], [v.ps, v.id, v.gone]);
});

await test('recordDay: re-running a day replaces it; the files replay; later days continue', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'archive-'));
  try {
    const d1 = [plan('A1E1'), plan('B1E1')];
    await recordDay({ dir, plans: d1, listed: listedOf(d1), feedOk: ok, date: '2026-11-07' });
    const d2 = [plan('A1E1', { rate: 0.33, up: 'y' }), plan('B1E1')];
    await recordDay({ dir, plans: d2, listed: listedOf(d2), feedOk: ok, date: '2026-11-08' });
    const first = await readFile(join(dir, 'events', '2026', '2026-11-08.jsonl'), 'utf8');
    await recordDay({ dir, plans: d2, listed: listedOf(d2), feedOk: ok, date: '2026-11-08' }); // rerun
    assert.equal(await readFile(join(dir, 'events', '2026', '2026-11-08.jsonl'), 'utf8'), first);
    assert.equal(first.trim().split('\n').length, 1);
    const run = await recordDay({ dir, plans: d2, listed: listedOf(d2), feedOk: ok, date: '2026-11-09' });
    assert.equal(run.price + run.new + run.gone, 0);
    await assert.rejects(recordDay({ dir, plans: d2, listed: listedOf(d2), feedOk: ok, date: '2026-11-01' }), /later than/);
    assert.deepEqual((await readdir(join(dir, 'events', '2026'))).sort(), ['2026-11-07.jsonl', '2026-11-08.jsonl', '2026-11-09.jsonl']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await test('an archive that lost its state refuses to start over; the summary ignores day-one "new"', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'archive-'));
  try {
    const d1 = [plan('A1E1'), plan('B1E1')];
    await recordDay({ dir, plans: d1, listed: listedOf(d1), feedOk: ok, date: '2026-11-07' });
    const d2 = [plan('A1E1', { rate: 0.4, up: 'z' }), plan('B1E1'), plan('C1E1')];
    await recordDay({ dir, plans: d2, listed: listedOf(d2), feedOk: ok, date: '2026-11-08' });
    assert.deepEqual((await historySummary(dir)).last30, { price: 1, new: 1, gone: 0 });
    await unlink(join(dir, 'state.json'));
    await assert.rejects(recordDay({ dir, plans: d2, listed: listedOf(d2), feedOk: ok, date: '2026-11-09' }), /not starting a new history/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await test('a canonical-form version bump records a rebase, never price changes', async () => {
  const ps = [plan('A1E1')];
  const d1 = step(null, ps, listedOf(ps), ok, '2026-11-07');
  const old = { ...d1.state, sigVersion: 0 };
  const r = step(old, ps, listedOf(ps), ok, '2026-11-08');
  assert.deepEqual(evs(r), ['rebase:A1E']);
  assert.equal(r.stats.price, 0);
});

await test('priceOf ignores plans without a tariff', () => {
  assert.equal(priceOf({ detail: true, e: { tp: [] } }), null);
  assert.equal(priceOf({ detail: false, e: plan('x').e }), null);
});

console.log(`${n} passed`);
