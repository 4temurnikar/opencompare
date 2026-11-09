#!/usr/bin/env node
// The weekly energy brief: what changed in the past seven days, written from fixed sentence templates
// so every number comes straight from the data.
//
//   node pipeline/energy/brief.mjs draft [YYYY-MM-DD]    build this week's brief as an unlisted preview
//                                                       (Mondays only unless a date is given)
//   node pipeline/energy/brief.mjs publish [YYYY-MM-DD]  publish a previewed brief (default: the latest)
//
// Sources: the private price history (archive/energy), today's plans, boards and data quality.
// Rules that keep it honest:
//  - a "change" is a change in what a typical home pays, worked out with the same calculator as the
//    site, from the prices recorded at the start and end of the week (a plan that went up and back
//    down again isn't a change);
//  - price changes the retailer didn't date ("unconfirmed" in the history) are left out of the
//    headline numbers and reported separately;
//  - business plans, demand tariffs and plans flagged with serious data problems aren't priced;
//  - wording states facts, never motives or judgements.
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { annualCost, bestFit, DEFAULTS } from '../../site/energy-cost.js';
import { seriesKey, melbourneDate } from './archive.mjs';
import { isDemand } from './insights.mjs';
import { networkStates } from './normalise.mjs';
import { config } from '../config.mjs';
import { page, signupBox, siteConfig, esc, longDate, buildPages, SITE } from '../site-pages.mjs';

const DATA = join(SITE, 'data', 'brief');
const dayShift = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const money = (n) => `$${Math.round(Math.abs(n)).toLocaleString('en-AU')}`;
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-AU')} ${n === 1 ? one : many}`;
const FUEL = { E: 'electricity', G: 'gas' };
const STATE_NAME = { NSW: 'NSW', VIC: 'Victoria', QLD: 'Queensland', SA: 'South Australia', ACT: 'the ACT', TAS: 'Tasmania' };

// ---------- inputs
async function readEvents(dir, upTo) {
  const out = [];
  let years = [];
  try {
    years = (await readdir(join(dir, 'events'))).sort();
  } catch {
    return out;
  }
  for (const y of years)
    for (const f of (await readdir(join(dir, 'events', y))).sort()) {
      if (!f.endsWith('.jsonl') || f.slice(0, 10) > upTo) continue;
      for (const line of (await readFile(join(dir, 'events', y, f), 'utf8')).split('\n')) if (line.trim()) out.push(JSON.parse(line));
    }
  return out;
}

/**
 * Work out the brief for the week ending `date`. Pure: everything it needs is passed in.
 * @param events   price-history events up to and including `date`
 * @param plans    today's plans (normalised records)
 * @param boards   today's headline boards
 * @param quality  today's data-quality summary
 * @param prev     the previous brief's data (for week-on-week comparisons), or null
 */
export function computeBrief({ events, plans, boards, quality, prev, date }) {
  const from = dayShift(date, -6);
  const before = dayShift(date, -7); // prices as they stood at the end of this day
  const firstDay = events.reduce((m, e) => (e.d < m ? e.d : m), '9999');
  if (firstDay > before) return { date, from, skipped: `the price history starts on ${firstDay}; a brief needs it to start by ${before}` };

  // Prices and status of every series at the start and end of the week
  const atStart = new Map();
  const atEnd = new Map();
  const inWeek = new Map(); // key -> events this week
  for (const e of events) {
    const target = e.d <= before ? [atStart, atEnd] : e.d <= date ? [atEnd] : [];
    for (const m of target) {
      const s = m.get(e.k) || { p: null, gone: false, id: null, m: null };
      if (e.p) s.p = e.p;
      if (e.m) s.m = e.m;
      if (e.id) s.id = e.id;
      if (e.ev === 'gone') s.gone = true;
      if (e.ev === 'back') s.gone = false;
      m.set(e.k, s);
    }
    if (e.d > before && e.d <= date) (inWeek.get(e.k) || inWeek.set(e.k, []).get(e.k)).push(e);
  }
  const current = new Map(plans.map((p) => [seriesKey(p.id), p]));

  const counts = { tracked: [...atEnd.values()].filter((s) => s.p && !s.gone).length, retailers: new Set(plans.map((p) => p.r)).size, changed: 0, rises: 0, cuts: 0, other: 0, unpriced: 0, business: 0, unconfirmed: 0, new: 0, gone: 0 };
  const moves = [];
  const fit = { up: 0, down: 0 };
  const byRetailer = new Map();
  const tally = (r, k) => {
    const x = byRetailer.get(r) || byRetailer.set(r, { retailer: r, rises: 0, cuts: 0, other: 0, deltas: [] }).get(r);
    x[k]++;
    return x;
  };

  for (const [k, evs] of inWeek) {
    const s0 = atStart.get(k);
    const s1 = atEnd.get(k);
    if (evs.some((e) => e.ev === 'new') && !s0?.p) counts.new++;
    if (s1?.gone && !s0?.gone) counts.gone++;
    if (!s0?.p || !s1?.p || s0.gone || s1.gone) continue;
    if (JSON.stringify(s0.p) === JSON.stringify(s1.p)) continue;
    // Which events moved the price, and were they dated by the retailer?
    const moved = evs.filter((e) => e.p && e.ev !== 'rebase');
    if (!moved.length) continue; // only a re-recording of the same prices
    const confirmed = moved.some((e) => e.q !== 'unconfirmed');
    const plan = current.get(k);
    const name = plan?.n || s1.m?.n || k;
    const retailer = plan?.r || evs.find((e) => e.b)?.b || 'Unknown retailer';
    if (!confirmed) {
      counts.unconfirmed++;
      continue;
    }
    counts.changed++;
    const cu = plan?.cu || s1.m?.cu;
    if (cu === 'BUSINESS') {
      counts.business++;
      continue;
    }
    // Bill impact for a typical home, per fuel, with the site's own calculator
    let any = false;
    let priced = false;
    for (const fuel of ['E', 'G']) {
      const c0 = s0.p[fuel === 'E' ? 'e' : 'g'];
      const c1 = s1.p[fuel === 'E' ? 'e' : 'g'];
      if (!c0?.tp?.length || !c1?.tp?.length) continue;
      if (plan && (plan.bad || isDemand({ ...plan, e: c1, g: c1 }, fuel))) continue;
      const b0 = annualCost({ e: c0, g: c0 }, fuel, { usage: DEFAULTS[fuel].usage });
      const b1 = annualCost({ e: c1, g: c1 }, fuel, { usage: DEFAULTS[fuel].usage });
      if (!b0 || !b1 || b0.flags.length || b1.flags.length) continue;
      priced = true;
      const delta = b1.total - b0.total;
      if (fuel === 'E') {
        const f0 = bestFit(c0);
        const f1 = bestFit(c1);
        if (f0 !== null && f1 !== null && Math.abs(f1 - f0) >= 0.0005) f1 > f0 ? fit.up++ : fit.down++;
      }
      if (Math.abs(delta) < 1) continue;
      any = true;
      const nets = plan?.d || s1.m?.d || [];
      // states the plan's own networks are in (not states it reaches only through border postcodes)
      const states = [...new Set(nets.flatMap((d) => networkStates(d)))].filter((x) => (plan?.st || s1.m?.st || []).includes(x));
      moves.push({ key: k, id: s1.id, retailer, plan: name, fuel, networks: nets, states, before: b0.total, after: b1.total, delta });
    }
    const rise = moves.filter((m) => m.key === k).reduce((a, m) => a + m.delta, 0);
    if (!priced) counts.unpriced++, tally(retailer, 'other');
    else if (!any) counts.other++, tally(retailer, 'other');
    else if (rise > 0) counts.rises++, tally(retailer, 'rises').deltas.push(...moves.filter((m) => m.key === k).map((m) => m.delta));
    else counts.cuts++, tally(retailer, 'cuts').deltas.push(...moves.filter((m) => m.key === k).map((m) => m.delta));
  }

  // The same plan is often published once per network or customer group: show it once, with ranges
  const baseName = (n) => n.replace(/\s*[-–]\s*(3rd party|third party|new to [\w ]+|existing customers?|new customers?)$/i, '').trim();
  const grouped = (list) => {
    const g = new Map();
    for (const m of list) {
      const key = `${m.retailer}|${baseName(m.plan)}|${m.fuel}`;
      const x = g.get(key) || g.set(key, { retailer: m.retailer, plan: baseName(m.plan), fuel: m.fuel, versions: 0, networks: [], states: [], lo: Infinity, hi: -Infinity, nowLo: Infinity, nowHi: -Infinity, ids: [] }).get(key);
      x.versions++;
      x.ids.push(m.id);
      x.lo = Math.min(x.lo, m.delta);
      x.hi = Math.max(x.hi, m.delta);
      x.nowLo = Math.min(x.nowLo, m.after);
      x.nowHi = Math.max(x.nowHi, m.after);
      for (const d of m.networks) if (!x.networks.includes(d)) x.networks.push(d);
      for (const st of m.states) if (!x.states.includes(st)) x.states.push(st);
    }
    return [...g.values()].map((x) => ({ ...x, delta: Math.abs(x.hi) > Math.abs(x.lo) ? x.hi : x.lo, ids: x.ids.slice(0, 20) }));
  };
  const rises = grouped(moves.filter((m) => m.delta > 0)).sort((a, b) => b.delta - a.delta || a.plan.localeCompare(b.plan)).slice(0, 5);
  const cuts = grouped(moves.filter((m) => m.delta < 0)).sort((a, b) => a.delta - b.delta || a.plan.localeCompare(b.plan)).slice(0, 5);
  const retailers = [...byRetailer.values()]
    .map((r) => ({ retailer: r.retailer, rises: r.rises, cuts: r.cuts, other: r.other, avg: r.deltas.length ? Math.round(r.deltas.reduce((a, b) => a + b, 0) / r.deltas.length) : null }))
    .sort((a, b) => b.rises + b.cuts + b.other - (a.rises + a.cuts + a.other) || a.retailer.localeCompare(b.retailer))
    .slice(0, 12);

  // Cheapest open market plan on each state's main network, against last week's brief
  const prevCheap = new Map((prev?.cheapest || []).map((x) => [x.board, x]));
  const cheapest = boards
    .filter((b) => b.ranking?.length)
    .map((b) => {
      const top = b.ranking[0];
      const was = prevCheap.get(b.id);
      return { board: b.id, fuel: b.fuel, state: b.state, network: b.network, retailer: top.retailer, plan: top.plan, cost: top.cost, median: b.median, prev: was && was.network === b.network ? { retailer: was.retailer, plan: was.plan, cost: was.cost } : null };
    })
    .sort((a, b) => (a.fuel === b.fuel ? Object.keys(STATE_NAME).indexOf(a.state) - Object.keys(STATE_NAME).indexOf(b.state) : a.fuel === 'E' ? -1 : 1));

  const lv = { 1: 0, 2: 0 };
  for (const b of quality?.brands || []) for (const l of [1, 2]) lv[l] += b.levels?.[l] || 0;
  const dq = { critical: lv[1], major: lv[2], prev: prev?.quality ? { critical: prev.quality.critical, major: prev.quality.major } : null };

  const out = { date, from, generatedAt: new Date().toISOString(), typical: { E: DEFAULTS.E.usage, G: DEFAULTS.G.usage }, counts, rises, cuts, retailers, fit, cheapest, quality: dq };
  Object.assign(out, words(out));
  return out;
}

// ---------- words (fixed templates)
function words(b) {
  const c = b.counts;
  const moved = c.rises + c.cuts;
  const title = moved ? `Energy prices this week: ${plural(c.rises, 'plan')} up, ${c.cuts.toLocaleString('en-AU')} down` : 'A quiet week for energy prices';
  const parts = [];
  if (c.changed) {
    const bits = [];
    if (c.rises) bits.push(`${plural(c.rises, 'home plan')} now ${c.rises === 1 ? 'costs' : 'cost'} a typical household more`);
    if (c.cuts) bits.push(`${c.cuts.toLocaleString('en-AU')} ${c.rises ? '' : `home plan${c.cuts === 1 ? '' : 's'} `}${c.cuts === 1 ? 'costs' : 'cost'} less`);
    if (c.other) bits.push(`${plural(c.other, 'home plan')} changed in ways that don't affect a typical bill, such as fees or feed-in tariffs`);
    if (c.unpriced) bits.push(`${plural(c.unpriced, 'home plan')} changed that we can't price for a typical home, such as demand tariffs`);
    if (c.business) bits.push(`${plural(c.business, 'business plan')} changed`);
    const list = bits.length > 1 ? `${bits.slice(0, -1).join(', ')} and ${bits[bits.length - 1]}` : bits[0];
    parts.push(`In the seven days to ${longDate(b.date)}, retailers changed prices on ${plural(c.changed, 'plan')}${list ? `: ${list}` : ''}.`);
  } else parts.push(`In the seven days to ${longDate(b.date)}, no retailer changed the prices of a published plan.`);
  if (c.new || c.gone) parts.push(`Retailers ${[c.new ? `launched ${plural(c.new, 'new plan')}` : '', c.gone ? `withdrew ${plural(c.gone, 'plan')}` : ''].filter(Boolean).join(' and ')}.`);
  const big = [];
  if (b.rises[0]) big.push(`The biggest rise was on ${b.rises[0].retailer}'s ${b.rises[0].plan} (${FUEL[b.rises[0].fuel]}): up to ${money(b.rises[0].delta)} a year for a typical home.`);
  if (b.cuts[0]) big.push(`The biggest cut was on ${b.cuts[0].retailer}'s ${b.cuts[0].plan} (${FUEL[b.cuts[0].fuel]}): up to ${money(b.cuts[0].delta)} a year less.`);
  return { title, lead: [...parts, ...big].join(' ') };
}

// ---------- rendering
const where = (m) => [m.networks.slice(0, 2).join(', ') + (m.networks.length > 2 ? ' and others' : ''), m.states.filter((s) => STATE_NAME[s]).join(', ')].filter(Boolean).join(' · ');
const range = (lo, hi, sign = false) => {
  const f = (v) => `${sign ? (v > 0 ? '+' : '−') : ''}${money(v)}`;
  return lo === hi ? f(lo) : `${f(lo)} to ${f(hi)}`;
};
function movesTable(list, caption) {
  if (!list.length) return '';
  return `<h3>${caption}</h3><div class="table-wrap"><table><thead><tr><th>Retailer and plan</th><th>Where</th><th class="num">Typical bill now</th><th class="num">Change a year</th></tr></thead><tbody>${list
    .map((m) => `<tr><td><b>${esc(m.retailer)}</b><br />${esc(m.plan)} <span class="muted small">(${FUEL[m.fuel]}${m.versions > 1 ? `, ${m.versions} versions` : ''})</span></td><td class="small">${esc(where(m))}</td><td class="num">${range(m.nowLo, m.nowHi)}</td><td class="num"><b>${range(Math.abs(m.lo) < Math.abs(m.hi) ? m.lo : m.hi, Math.abs(m.lo) < Math.abs(m.hi) ? m.hi : m.lo, true)}</b></td></tr>`)
    .join('')}</tbody></table></div>`;
}

export function renderBody(b, { c, root, preview = false }) {
  const n = b.counts;
  const head = `${preview ? `<p class="preview-banner">Preview — not yet published. Only people with this link can see it; it isn't listed or emailed. To publish it, run the <b>Publish weekly brief</b> workflow.</p>` : ''}
<p class="kicker">Weekly energy brief · ${longDate(b.date)}</p>
<h1>${esc(b.title)}</h1>
<p class="lede">${esc(b.lead)}</p>`;
  const stats = `<div class="brief-stats">${[
    [n.rises, 'home plans up'],
    [n.cuts, 'home plans down'],
    [n.new, 'new plans'],
    [n.gone, 'withdrawn'],
  ]
    .map(([v, l]) => `<div class="card"><div class="bs-v">${v.toLocaleString('en-AU')}</div><div class="bs-l">${l}</div></div>`)
    .join('')}</div>`;
  const moves = n.rises + n.cuts ? `<h2>Biggest changes for a typical home</h2>${movesTable(b.rises, 'Largest rises')}${movesTable(b.cuts, 'Largest cuts')}` : '';
  const rt = b.retailers.length
    ? `<h2>Changes by retailer</h2><div class="table-wrap"><table><thead><tr><th>Retailer</th><th class="num">Up</th><th class="num">Down</th><th class="num">Other changes</th><th class="num">Average change, typical home</th></tr></thead><tbody>${b.retailers
        .map((r) => `<tr><td>${esc(r.retailer)}</td><td class="num">${r.rises}</td><td class="num">${r.cuts}</td><td class="num">${r.other}</td><td class="num">${r.avg === null ? '—' : `${r.avg > 0 ? '+' : r.avg < 0 ? '−' : ''}${money(r.avg)} a year`}</td></tr>`)
        .join('')}</tbody></table></div>`
    : '';
  const fitP = b.fit.up || b.fit.down ? `<p>Solar feed-in tariffs went up on ${plural(b.fit.up, 'home plan')} and down on ${plural(b.fit.down, 'home plan')}.</p>` : '';
  const cheap = b.cheapest.length
    ? `<h2>Cheapest plan for a typical home, by state</h2><div class="table-wrap"><table><thead><tr><th>State and network</th><th>Cheapest open market plan</th><th class="num">A year</th><th class="num">Typical market plan</th><th>Last week</th></tr></thead><tbody>${b.cheapest
        .map((x) => {
          const was = !x.prev ? '—' : x.prev.retailer === x.retailer && x.prev.plan === x.plan ? (x.prev.cost === x.cost ? 'Same plan, same price' : `Same plan, ${money(x.prev.cost)}`) : `${esc(x.prev.retailer)}, ${money(x.prev.cost)}`;
          return `<tr><td>${esc(x.state === 'ACT' ? 'ACT' : STATE_NAME[x.state] || x.state)} ${FUEL[x.fuel]}<br /><span class="muted small">${esc(x.network)}</span></td><td><b>${esc(x.retailer)}</b><br />${esc(x.plan)}</td><td class="num">${money(x.cost)}</td><td class="num">${x.median ? money(x.median) : '—'}</td><td class="small">${was}</td></tr>`;
        })
        .join('')}</tbody></table></div><p class="small muted">Plans open to everyone, for a typical home on the network with the most households or plans in each state. <a href="${root}#electricity">Compare plans for your postcode</a>.</p>`
    : '';
  const dq = `<h2>Data quality</h2><p>Retailers' published plan data currently has ${plural(b.quality.critical, 'critical finding')} and ${plural(b.quality.major, 'major finding')}${b.quality.prev ? ` (last week: ${b.quality.prev.critical} and ${b.quality.prev.major})` : ''}. <a href="${root}#data-quality">See the data-quality report</a>.</p>`;
  const unconf = n.unconfirmed ? `<p class="small muted">${plural(n.unconfirmed, 'further plan')} showed a price change without a new "last updated" date from the retailer. We're checking ${n.unconfirmed === 1 ? 'it' : 'them'}, so ${n.unconfirmed === 1 ? "it isn't" : "they aren't"} included above.</p>` : '';
  const how = `<h2>How this is worked out</h2><p class="small">A typical home uses ${b.typical.E.toLocaleString('en-AU')} kWh of electricity or ${b.typical.G.toLocaleString('en-AU')} MJ of gas a year, spread over the day in a typical pattern. Yearly costs include GST and discounts everyone gets, but not solar, controlled load or conditional discounts. Changes compare each plan's prices on ${longDate(dayShift(b.date, -7))} with ${longDate(b.date)}, using the same calculator as the <a href="${root}#electricity">plan finder</a>. Prices are as published by each retailer through the Consumer Data Right. Business plans and demand tariffs are counted but not priced. <a href="${root}#methodology">Methodology</a>.</p><p class="small muted">General information only, not a recommendation for your circumstances; check a plan's fact sheet before switching.</p>`;
  return `<article class="prose brief">${head}${stats}${moves}${fitP}${rt}${cheap}${dq}${unconf}${how}${preview ? '' : signupBox(c, root)}</article>`;
}

/** A simpler copy for email (sent from the RSS feed): no site navigation, absolute links. */
function emailHtml(b, c) {
  const abs = `${c.siteUrl}/`;
  const html = renderBody(b, { c: { ...c, newsletter: { enabled: false } }, root: abs, preview: false });
  return `${html}<p><a href="${abs}brief/${b.date}/">Read this brief on OpenCompare</a></p>`;
}

// ---------- CLI
async function readJson(p, fallback = null) {
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch {
    return fallback;
  }
}
async function loadIndex() {
  return (await readJson(join(DATA, 'index.json'))) || { briefs: [] };
}
async function saveIndex(idx) {
  idx.briefs.sort((a, b) => (a.date < b.date ? 1 : -1));
  await writeFile(join(DATA, 'index.json'), JSON.stringify(idx, null, 1));
}

async function draft(date) {
  const idx = await loadIndex();
  if (idx.briefs.find((x) => x.date === date && x.published)) return console.log(`Brief ${date} is already published; leaving it as it is`);
  const E = config.energy;
  const OUT = join(SITE, 'data', 'energy');
  const plans = new Map();
  for (const f of (await readdir(OUT)).filter((f) => /^plans-[A-Z]+\.json$/.test(f))) for (const p of await readJson(join(OUT, f), [])) plans.set(p.id, p);
  const events = await readEvents(E.archive.dir, date);
  if (!events.length) return console.log('Brief skipped: no price history available');
  const prevDate = idx.briefs.map((x) => x.date).filter((d) => d < date).sort().pop();
  const prev = prevDate ? await readJson(join(DATA, `${prevDate}.json`)) : null;
  const b = computeBrief({ events, plans: [...plans.values()], boards: await readJson(join(OUT, 'boards.json'), []), quality: await readJson(join(OUT, 'quality.json'), {}), prev, date });
  if (b.skipped) return console.log(`Brief skipped: ${b.skipped}`);
  await mkdir(DATA, { recursive: true });
  await writeFile(join(DATA, `${date}.json`), JSON.stringify(b, null, 1));
  const c = await siteConfig();
  const dir = join(SITE, 'brief', 'preview', date);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.html'), page({ c, root: '../../../', path: `brief/preview/${date}/`, title: `Preview: ${b.title}`, description: b.lead, body: renderBody(b, { c, root: '../../../', preview: true }), noindex: true, current: 'brief' }));
  idx.briefs = idx.briefs.filter((x) => x.date !== date);
  idx.briefs.push({ date, title: b.title, lead: b.lead, published: false });
  await saveIndex(idx);
  console.log(`Brief ${date} drafted: "${b.title}". Preview: ${c.siteUrl}/brief/preview/${date}/`);
  if (process.env.BRIEF_AUTO_PUBLISH === '1') await publish(date);
}

async function publish(date) {
  const idx = await loadIndex();
  const entry = date ? idx.briefs.find((x) => x.date === date) : idx.briefs.filter((x) => !x.published).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  if (!entry) throw new Error(date ? `no drafted brief for ${date}` : 'no unpublished brief to publish');
  const b = await readJson(join(DATA, `${entry.date}.json`));
  const c = await siteConfig();
  const dir = join(SITE, 'brief', entry.date);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.html'), page({ c, root: '../../', path: `brief/${entry.date}/`, title: `${b.title} | OpenCompare`, description: b.lead, body: renderBody(b, { c, root: '../../' }), current: 'brief' }));
  await writeFile(join(dir, 'email.html'), emailHtml(b, c));
  await rm(join(SITE, 'brief', 'preview', entry.date), { recursive: true, force: true });
  entry.published = true;
  entry.publishedAt = new Date().toISOString();
  await saveIndex(idx);
  await buildPages();
  console.log(`Brief ${entry.date} published: ${c.siteUrl}/brief/${entry.date}/`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd = 'draft', arg] = process.argv.slice(2);
  const today = melbourneDate();
  if (cmd === 'draft') {
    const date = arg || process.env.BRIEF_DATE || today;
    const monday = new Date(`${date}T12:00:00Z`).getUTCDay() === 1;
    if (!arg && !process.env.BRIEF_DATE && !monday) console.log(`Brief: not Monday (${date}), nothing to do`);
    else await draft(date);
  } else if (cmd === 'publish') await publish(arg || process.env.BRIEF_DATE || null);
  else throw new Error(`unknown command ${cmd}`);
}
