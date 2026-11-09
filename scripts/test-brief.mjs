#!/usr/bin/env node
// Tests for the weekly brief and the headline boards it relies on. Run: node scripts/test-brief.mjs
import assert from 'node:assert/strict';
import { step } from '../pipeline/energy/archive.mjs';
import { computeBrief, renderBody } from '../pipeline/energy/brief.mjs';
import { mainNetworks } from '../pipeline/energy/insights.mjs';
import { annualCost, bestFit } from '../site/energy-cost.js';

const plan = (id, o = {}) => ({
  id,
  b: 'sparky',
  r: o.r ?? 'Sparky Energy',
  n: o.n ?? `Plan ${id.replace(/\d+$/, '')}`,
  t: 'MARKET',
  cu: o.cu ?? 'RESIDENTIAL',
  f: 'ELECTRICITY',
  st: o.st ?? ['NSW'],
  d: o.d ?? ['Ausgrid'],
  up: o.up ?? 'u0',
  detail: true,
  e: {
    tp: [{ sd: '01-01', ed: '12-31', sup: o.sup ?? 1.1, kind: 'single', blocks: [{ p: o.rate ?? 0.3, v: null, u: 'KWH' }], per: 'P1D' }],
    fit: [{ kind: 'single', payer: 'RETAILER', blocks: [{ p: o.fit ?? 0.05, v: null, u: 'KWH' }] }],
    disc: [],
    fees: [],
  },
});
const ok = new Map([['f', true]]);
const days = (start, n) => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${start}T12:00:00Z`) + i * 864e5).toISOString().slice(0, 10));

/** Run the archive over a sequence of days (each day a list of plans) and return all events + the last day's plans */
function history(seq, start = '2026-11-08') {
  let s = null;
  const events = [];
  const ds = days(start, seq.length);
  seq.forEach((ps, i) => {
    const r = step(s, ps, new Map(ps.map((p) => [p.id, 'f'])), ok, ds[i]);
    events.push(...r.events);
    s = r.state;
  });
  return { events, plans: seq[seq.length - 1], date: ds[ds.length - 1] };
}
const brief = (h, extra = {}) => computeBrief({ events: h.events, plans: h.plans, boards: [], quality: { brands: [] }, prev: null, date: h.date, ...extra });
const week = (base, changes) => [base, ...Array.from({ length: 7 }, (_, i) => (changes[i] ? changes[i] : changes.last || base))];
let n = 0;
const test = (name, fn) => {
  fn();
  n++;
  console.log(`  ok  ${name}`);
};

console.log('Weekly brief');

test('needs a full week of history before the first brief', () => {
  const h = history([[plan('A1')], [plan('A1')]]);
  assert.match(brief(h).skipped, /history starts/);
});

test('a rise and a cut, with bill changes from the site calculator', () => {
  const base = [plan('A1'), plan('B1'), plan('C1')];
  const after = [plan('A1', { rate: 0.33, up: 'u1' }), plan('B1', { sup: 1.0, up: 'u1' }), plan('C1')];
  const h = history(week(base, { 2: after, last: after }));
  const b = brief(h);
  assert.equal(b.counts.changed, 2);
  assert.equal(b.counts.rises, 1);
  assert.equal(b.counts.cuts, 1);
  const expect = annualCost(plan('A1', { rate: 0.33 }), 'E').total - annualCost(plan('A1'), 'E').total;
  assert.equal(b.rises[0].delta, expect);
  assert.equal(b.rises[0].plan, 'Plan A');
  assert.equal(b.rises[0].versions, 1);
  assert.equal(b.cuts[0].delta, annualCost(plan('B1', { sup: 1.0 }), 'E').total - annualCost(plan('B1'), 'E').total);
  assert.match(b.title, /1 plan up, 1 down/);
});

test('up then back down within the week is not a change', () => {
  const base = [plan('A1')];
  const h = history(week(base, { 1: [plan('A1', { rate: 0.4, up: 'u1' })], 3: [plan('A1', { up: 'u2' })], last: [plan('A1', { up: 'u2' })] }));
  const b = brief(h);
  assert.equal(b.counts.changed, 0);
  assert.equal(b.title, 'A quiet week for energy prices');
});

test('undated (unconfirmed) changes are kept out of the headline numbers', () => {
  const base = [plan('A1')];
  const after = [plan('A1', { rate: 0.4 })]; // same lastUpdated
  const b = brief(history(week(base, { 1: after, last: after })));
  assert.equal(b.counts.unconfirmed, 1);
  assert.equal(b.counts.rises, 0);
  assert.equal(b.rises.length, 0);
});

test('business plans are counted but not priced', () => {
  const base = [plan('A1', { cu: 'BUSINESS' })];
  const after = [plan('A1', { cu: 'BUSINESS', rate: 0.4, up: 'u1' })];
  const b = brief(history(week(base, { 1: after, last: after })));
  assert.equal(b.counts.business, 1);
  assert.equal(b.rises.length, 0);
});

test('a demand tariff without published demand charges is counted but not priced', () => {
  const base = [plan('A1', { n: 'Saver (Demand)' })];
  const after = [plan('A1', { n: 'Saver (Demand)', rate: 0.4, up: 'u1' })];
  const b = brief(history(week(base, { 1: after, last: after })));
  assert.equal(b.counts.unpriced, 1);
  assert.equal(b.rises.length, 0);
});

test('a feed-in-only change is "other", and counted as a feed-in change', () => {
  const base = [plan('A1')];
  const after = [plan('A1', { fit: 0.07, up: 'u1' })];
  const b = brief(history(week(base, { 1: after, last: after })));
  assert.equal(b.counts.other, 1);
  assert.deepEqual(b.fit, { up: 1, down: 0 });
});

test('new and withdrawn plans in the week', () => {
  const base = [plan('A1'), plan('B1')];
  const later = [plan('A1'), plan('C1')]; // B missing from day 2 on -> withdrawn on day 3; C new
  const b = brief(history(week(base, { 1: later, last: later })));
  assert.equal(b.counts.new, 1);
  assert.equal(b.counts.gone, 1);
});

test('a change before the week started is not this week’s news', () => {
  const base = [plan('A1')];
  const after = [plan('A1', { rate: 0.4, up: 'u1' })];
  const seq = [base, after, after, after, after, after, after, after, after]; // changed on day 2 of 9
  const b = brief(history(seq, '2026-11-07'));
  assert.equal(b.counts.changed, 0);
});

test('a new version of a plan with a new price is a change to that plan', () => {
  const base = [plan('AGL1059355MBE4@EME')];
  const after = [plan('AGL1059355MBE5@EME', { rate: 0.32 })];
  const b = brief(history(week(base, { 2: after, last: after })));
  assert.equal(b.counts.rises, 1);
});

test('the rendered page has the facts and no gaps', () => {
  const base = [plan('A1'), plan('B1')];
  const after = [plan('A1', { rate: 0.33, up: 'u1' }), plan('B1', { sup: 1.0, up: 'u1' })];
  const b = brief(history(week(base, { 2: after, last: after })), {
    boards: [{ id: 'E-NSW', fuel: 'E', state: 'NSW', network: 'Ausgrid', median: 1500, ranking: [{ retailer: 'Sparky Energy', plan: 'Plan A', cost: 1400 }] }],
    quality: { brands: [{ levels: { 1: 0, 2: 3 } }] },
  });
  const html = renderBody(b, { c: { siteUrl: 'https://x', newsletter: {} }, root: '../../' });
  for (const bad of ['undefined', 'NaN', 'null', '[object']) assert.ok(!html.includes(bad), `page contains "${bad}"`);
  assert.ok(html.includes('Largest rises') && html.includes('Largest cuts') && html.includes('Ausgrid') && html.includes('3 major findings'));
});

console.log('Headline boards');

const net = (id, st, d, o = {}) => ({ ...plan(id, o), st, d });
test('a state is ranked on its own network, not a neighbour’s that lists border postcodes', () => {
  const ps = [];
  for (let i = 0; i < 5; i++) ps.push(net(`E${i}`, ['NSW', 'ACT', 'VIC'], ['Essential Energy']));
  for (let i = 0; i < 2; i++) ps.push(net(`V${i}`, ['ACT'], ['Evoenergy']), net(`W${i}`, ['VIC'], ['Citipower']));
  const m = Object.fromEntries(mainNetworks(ps, 'E').map((x) => [x.state, x.network]));
  assert.deepEqual(m, { NSW: 'Essential Energy', ACT: 'Evoenergy', VIC: 'Citipower' });
});

test('NSW headlines Ausgrid even when another network lists more plans', () => {
  const ps = [];
  for (let i = 0; i < 5; i++) ps.push(net(`E${i}`, ['NSW'], ['Essential Energy']));
  ps.push(net('A0', ['NSW'], ['Ausgrid']));
  assert.equal(mainNetworks(ps, 'E')[0].network, 'Ausgrid');
});

test('a solar rate paid only in the evening is not a solar home’s rate', () => {
  const c = { fit: [{ payer: 'RETAILER', kind: 'tv', tv: [{ blocks: [{ p: 0.4 }], win: [{ s: '17:30', e: '21:29' }] }] }, { payer: 'RETAILER', kind: 'tv', tv: [{ blocks: [{ p: 0.01 }], win: [{ s: '09:00', e: '17:29' }] }] }] };
  assert.equal(bestFit(c), 0.01);
});

console.log(`${n} passed`);
