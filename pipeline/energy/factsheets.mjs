// Finds each retailer's own plan fact sheets (Basic Plan Information Documents, Victorian Energy
// Fact Sheets, price pages) on its website, so CDR prices can be checked against them.
//
// The AER's CDR feed carries few or no links to these documents, so we look for them ourselves:
// the retailer's sitemaps, its fact-sheet and pricing pages, and the PDFs they link to. Documents
// are matched to plans by plan ID (e.g. AGL1059355MBE4), which every fact sheet shows. What we
// find is kept in an index that grows a little every day, within a time and page budget.
import { fetchDoc, sitemapsFor, site, cents } from '../web.mjs';

const STOP = new Set(['energy', 'power', 'gas', 'retail', 'group', 'pty', 'ltd', 'the', 'and', 'australia', 'for', 'powered', 'services', 'holdings', 'utilities', 'sample']);
/** Distinctive words of a retailer name, used to confirm a website belongs to it. */
export function nameTokens(name) {
  const all = String(name).toLowerCase().replace(/\(.*?\)/g, ' ').replace(/&/g, ' ').split(/[^a-z0-9]+/).filter(Boolean);
  const t = all.filter((w) => w.length >= 3 && !STOP.has(w));
  return t.length ? t : [all.join('')];
}
export const hostMatches = (host, name) => {
  const h = String(host).toLowerCase().replace(/[^a-z0-9]/g, '');
  return nameTokens(name).some((t) => h.includes(t));
};

/** Likely website addresses for a retailer name, most likely first. */
export function guessWebsites(name) {
  const words = String(name)
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/&/g, 'and')
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !['retail', 'group', 'pty', 'ltd', 'holdings', 'sample'].includes(w));
  if (!words.length) return [];
  const slugs = [...new Set([words.join(''), `${words[0]}energy`, words[0], `${words[0]}power`, words.join('-')])];
  return slugs.flatMap((s) => [`https://www.${s}.com.au`, `https://www.${s}.com`]).slice(0, 10);
}

// ---- plan IDs: AGL1059355MBE4, 1ST1213185MRE1, FP11199362MRE1, AMB798770MR (Victoria)
const ID_RE = /(?<![A-Z0-9])([A-Z0-9]{2,4}\d{5,8}[A-Z]{2,4}\d{0,3})(?![A-Z0-9])/g;
/** The version-free stem of a plan ID: AGL1059355MBE4@EME → AGL1059355MBE */
export const stemOf = (id) => String(id).split('@')[0].toUpperCase().replace(/(\D)\d{1,3}$/, '$1');
export function stemsIn(text, known) {
  const out = new Set();
  for (const m of String(text).toUpperCase().matchAll(ID_RE)) {
    const s = stemOf(m[1]);
    if (known.has(s)) out.add(s);
  }
  return out;
}
/**
 * Prices (in cents) near each plan ID in a document. A document about one plan gives all its prices
 * to that plan; a document covering several gives each plan the stretch from its ID to the next plan's ID.
 */
export function pricesByStem(text, known) {
  const up = text.toUpperCase();
  const hits = [];
  for (const m of up.matchAll(ID_RE)) {
    const s = stemOf(m[1]);
    if (known.has(s)) hits.push({ s, at: m.index, end: m.index + m[0].length });
  }
  const stems = new Set(hits.map((h) => h.s));
  const out = {};
  if (stems.size === 1) {
    out[[...stems][0]] = cents(text);
    return out;
  }
  hits.forEach((h, i) => {
    let stop = Math.min(text.length, h.at + 6000);
    for (let j = i + 1; j < hits.length; j++) if (hits[j].s !== h.s) { stop = Math.min(stop, hits[j].at); break; }
    const set = new Set(out[h.s] || []);
    for (const v of cents(text.slice(h.at, stop))) set.add(v);
    out[h.s] = [...set];
  });
  return out;
}

const PAGE_WORDS = /fact[\s_-]*sheets?|bpid|basic[\s_-]*plan|plan[\s_-]*information|price[\s_-]*(fact|list|sheet|guide)|energy[\s_-]*price|pricing|tariffs?|rates?\b|our[\s_-]*plans|\/plans?\b|electricity[\s_-]*plans|gas[\s_-]*plans/i;
const PDF_WORDS = /fact[\s_-]*sheet|bpid|basic[\s_-]*plan|plan[\s_-]*information|price|pricing|tariff|rates?\b|(?<![A-Za-z0-9])[A-Za-z0-9]{2,4}\d{5,8}[A-Za-z]{2,4}\d{0,3}(?![A-Za-z0-9])/i;
const COMMON_PATHS = ['/energy-fact-sheets', '/fact-sheets', '/energy-price-fact-sheets', '/basic-plan-information-documents', '/plans', '/pricing', '/energy-plans', '/rates'];
const isPdf = (u) => /\.pdf($|[?#])/i.test(u);
const sameSite = (u, origin) => {
  try {
    return site(new URL(u).hostname) === site(new URL(origin).hostname);
  } catch {
    return false;
  }
};
// Document hosts that websites commonly serve their PDFs from
const ASSET_HOSTS = /(^|\.)(ctfassets\.net|sanity\.io|amazonaws\.com|cloudfront\.net|azureedge\.net|blob\.core\.windows\.net|prismic\.io|storyblok\.com|website-files\.com|hubspotusercontent[\w-]*\.net|hubfs\.net|googleusercontent\.com|cdn\.[\w.-]+)$/i;
const docHostOk = (u, origin, name) => {
  try {
    const h = new URL(u).hostname;
    return sameSite(u, origin) || ASSET_HOSTS.test(h) || hostMatches(h, name);
  } catch {
    return false;
  }
};
const locs = (xml) => [...String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
const hash = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

/**
 * Work out a retailer's website: a configured address first, then a cached lookup, then guesses.
 * @returns {Promise<{url: string|null, how: string}>}
 */
export async function resolveWebsite({ brand, name, configured, cached, deadline, today }) {
  if (configured) return { url: configured.replace(/\/+$/, ''), how: 'configured' };
  if (configured === null) return { url: null, how: 'none' }; // explicitly no website (test data)
  const age = cached ? (Date.parse(today) - Date.parse(cached.at)) / 864e5 : Infinity;
  if (cached?.url && age < 30) return { url: cached.url, how: 'cached' };
  if (cached && !cached.url && age < 7) return { url: null, how: 'cached' };
  for (const g of guessWebsites(name)) {
    const d = await fetchDoc(g, deadline);
    if (d.skipped) return { url: cached?.url || null, how: 'skipped' };
    if (!d.ok || d.kind !== 'html') continue;
    const final = new URL(d.finalUrl || g);
    if (hostMatches(final.hostname, name)) return { url: final.origin, how: 'guessed' };
  }
  return { url: null, how: 'not found' };
}

/**
 * Grow one retailer's fact-sheet index and read the fact sheets of today's sample of plans.
 * @param o.website   the retailer's website origin
 * @param o.plans     the retailer's plans (records with id)
 * @param o.index     the retailer's saved index: { docs: { url: { stems, at, kind } }, pages: { url: at } }
 * @param o.limits    { pages, pdfs, sample }
 * @returns {{ index, stats, planDocs: Map<planId, {url, kind, values}[]>, sample }}
 */
export async function crawlRetailer({ website, name = '', plans, index = {}, deadline, limits, today }) {
  const origin = new URL(website).origin;
  const known = new Set(plans.map((p) => stemOf(p.id)));
  const idx = { docs: { ...(index.docs || {}) }, pages: { ...(index.pages || {}) } };
  const stats = { sitemapUrls: 0, pagesRead: 0, pdfsRead: 0, blocked: 0, docsFound: 0 };
  const read = new Map(); // url -> fetched doc with prices by stem (this run)
  const remember = (url, d) => {
    if (!d.ok || !d.text) return;
    const by = pricesByStem(d.text, known);
    const stems = Object.keys(by);
    read.set(url, { url: d.finalUrl || url, kind: d.kind, by });
    if (stems.length) idx.docs[url] = { stems, at: today, seen: today, kind: d.kind };
    else if (d.kind === 'pdf') idx.docs[url] = { stems: [], at: today, seen: today, kind: 'pdf' }; // read, nothing of ours: don't re-read for a while
  };

  // 1. Candidate pages and PDFs from sitemaps, plus the homepage and common fact-sheet addresses
  const pages = new Map(); // url -> priority (lower first)
  const pdfs = new Map();
  const addPdf = (u, p) => docHostOk(u, origin, name) && (!pdfs.has(u) || pdfs.get(u) > p) && pdfs.set(u, p);
  const addPage = (u, p) => sameSite(u, origin) && !isPdf(u) && (!pages.has(u) || pages.get(u) > p) && pages.set(u, p);
  let maps = await sitemapsFor(origin);
  if (!maps.length) maps = [`${origin}/sitemap.xml`];
  const seenMaps = new Set();
  for (let i = 0; i < maps.length && seenMaps.size < 8; i++) {
    const m = maps[i];
    if (seenMaps.has(m) || /\.gz($|\?)/i.test(m)) continue;
    seenMaps.add(m);
    const d = await fetchDoc(m, deadline, [], { raw: true });
    if (!d.ok || !d.raw) continue;
    const list = locs(d.raw);
    if (/<sitemapindex/i.test(d.raw)) {
      // child sitemaps: the ones likely to hold documents or plan pages first
      list.sort((a, b) => Number(!/pdf|doc|asset|media|file|plan|fact|price|page/i.test(a)) - Number(!/pdf|doc|asset|media|file|plan|fact|price|page/i.test(b)));
      maps.push(...list.slice(0, 12));
      continue;
    }
    stats.sitemapUrls += list.length;
    for (const u of list) {
      if (isPdf(u)) {
        if (PDF_WORDS.test(decodeURIComponent(u))) addPdf(u, stemsIn(u, known).size ? 0 : 1);
      } else if (PAGE_WORDS.test(new URL(u, origin).pathname)) addPage(u, 1);
    }
  }
  addPage(origin + '/', 2);
  for (const p of COMMON_PATHS) addPage(origin + p, 3);
  for (const u of Object.keys(idx.pages)) addPage(u, 1); // pages that led to fact sheets before

  // 2. Read pages (two hops from the start pages), collecting fact-sheet PDFs and pages that list plan IDs
  const pageQueue = [...pages.entries()].sort((a, b) => a[1] - b[1] || hash(today + a[0]) - hash(today + b[0])).map(([u]) => u);
  const visited = new Set();
  while (pageQueue.length && stats.pagesRead < limits.pages && Date.now() < deadline) {
    const u = pageQueue.shift();
    if (visited.has(u)) continue;
    visited.add(u);
    const d = await fetchDoc(u, deadline, [], { keepText: true, maxLinks: 2000 });
    if (d.blocked) stats.blocked++;
    if (!d.ok || d.kind !== 'html') continue;
    stats.pagesRead++;
    remember(u, d);
    let led = false;
    for (const l of d.links) {
      if (!docHostOk(l.href, origin, name)) continue;
      const label = `${l.text} ${decodeURIComponent(l.href)}`;
      if (isPdf(l.href)) {
        if (PDF_WORDS.test(label)) addPdf(l.href, stemsIn(label, known).size ? 0 : 1), (led = true);
      } else if (sameSite(l.href, origin) && PAGE_WORDS.test(label) && !visited.has(l.href) && !pageQueue.includes(l.href) && pageQueue.length < 400) pageQueue.push(l.href);
    }
    if (led || read.get(u)?.by && Object.keys(read.get(u).by).length) idx.pages[u] = today;
  }

  // 3. PDFs: those named after one of our plan IDs are indexed straight away; others are read,
  //    newest discoveries first, a limited number per day
  for (const [u] of pdfs) {
    if (idx.docs[u]) {
      idx.docs[u].seen = today;
      continue;
    }
    const s = [...stemsIn(decodeURIComponent(u), known)];
    if (s.length) idx.docs[u] = { stems: s, at: today, seen: today, kind: 'pdf', byName: true };
  }
  const unread = [...pdfs.keys()].filter((u) => !idx.docs[u] || (!idx.docs[u].stems.length && (Date.parse(today) - Date.parse(idx.docs[u].at)) / 864e5 > 30));
  unread.sort((a, b) => pdfs.get(a) - pdfs.get(b) || hash(today + a) - hash(today + b));
  for (const u of unread.slice(0, limits.pdfs)) {
    if (Date.now() > deadline) break;
    const d = await fetchDoc(u, deadline, [], { keepText: true });
    if (d.blocked) stats.blocked++;
    if (!d.ok) continue;
    stats.pdfsRead++;
    remember(u, d);
  }

  // 4. Today's sample: plans with a known fact sheet, rotating through them day by day
  const byStem = new Map();
  for (const [u, e] of Object.entries(idx.docs)) for (const s of e.stems) (byStem.get(s) || byStem.set(s, []).get(s)).push(u);
  const covered = plans.filter((p) => p.detail && byStem.has(stemOf(p.id)));
  const sample = covered.sort((a, b) => hash(today + a.id) - hash(today + b.id)).slice(0, limits.sample);
  const planDocs = new Map();
  for (const p of sample) {
    const s = stemOf(p.id);
    const list = [];
    for (const u of byStem.get(s).slice(0, 3)) {
      if (!read.has(u)) {
        const d = await fetchDoc(u, deadline, [], { keepText: true });
        if (d.ok && d.text) remember(u, d);
        else read.set(u, { url: u, kind: d.kind, by: {}, failed: d.skipped ? 'not read today (time limit)' : d.blocked ? 'blocked automated checks' : d.robots ? 'excluded by robots.txt' : d.error || (d.status ? `HTTP ${d.status}` : 'could not be read') });
        if (d.ok) d.kind === 'pdf' ? stats.pdfsRead++ : stats.pagesRead++;
      }
      const r = read.get(u);
      list.push({ url: r.url, kind: r.kind, values: r.by?.[s] || [], failed: r.failed || null });
    }
    planDocs.set(p.id, list);
  }
  // keep the index tidy: forget documents not seen for 60 days
  for (const [u, e] of Object.entries(idx.docs)) if ((Date.parse(today) - Date.parse(e.seen || e.at)) / 864e5 > 60) delete idx.docs[u];
  stats.docsFound = Object.values(idx.docs).filter((e) => e.stems.length).length;
  stats.plansCovered = covered.length;
  return { index: idx, stats, planDocs, sample };
}
