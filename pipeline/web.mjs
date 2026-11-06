// Reads the web pages and PDFs that each bank links to from its own CDR product data.
// Polite by design: robots.txt is respected, at most a couple of requests per host at a
// time, size and time limits, and only pages one click away from CDR-published URLs.
import { createRequire } from 'node:module';
import { config } from './config.mjs';

const W = config.web;
const require = createRequire(import.meta.url);

// ---------- small concurrency helpers
function semaphore(n) {
  let active = 0;
  const q = [];
  const next = () => {
    if (active >= n || !q.length) return;
    active++;
    const { fn, res, rej } = q.shift();
    fn().then(res, rej).finally(() => {
      active--;
      next();
    });
  };
  return (fn) => new Promise((res, rej) => (q.push({ fn, res, rej }), next()));
}
const globalLimit = semaphore(W.globalConcurrency);
const hostLimits = new Map();
const limitFor = (host) => (hostLimits.has(host) ? hostLimits.get(host) : (hostLimits.set(host, semaphore(W.perHostConcurrency)), hostLimits.get(host)));
export const webStats = { requests: 0, pdfs: 0, rendered: 0, blocked: 0, robots: 0, errors: 0, skipped: 0 };

// ---------- URLs published in a product's CDR data
const PRODUCT_PAGE_FIELDS = new Set(['overviewUri', 'feesAndPricingUri', 'termsUri', 'eligibilityUri', 'additionalOverviewUris', 'additionalFeesAndPricingUris']);
export function collectUris(p) {
  const out = [];
  const add = (url, field) => typeof url === 'string' && url.trim() && out.push({ url: url.trim(), field });
  add(p.applicationUri, 'applicationUri');
  const ai = p.additionalInformation || {};
  for (const k of ['overviewUri', 'termsUri', 'eligibilityUri', 'feesAndPricingUri', 'bundleUri']) add(ai[k], k);
  for (const k of ['additionalOverviewUris', 'additionalTermsUris', 'additionalEligibilityUris', 'additionalFeesAndPricingUris', 'additionalBundleUris'])
    for (const x of ai[k] || []) add(x?.additionalInfoUri, k);
  const walk = (o, path) => {
    if (Array.isArray(o)) o.forEach((x) => walk(x, path));
    else if (o && typeof o === 'object')
      for (const [k, v] of Object.entries(o)) {
        if (k === 'additionalInfoUri') add(v, `${path}.additionalInfoUri`);
        else if (v && typeof v === 'object') walk(v, `${path}.${k}`);
      }
  };
  for (const k of ['lendingRates', 'depositRates', 'fees', 'features', 'eligibility', 'constraints', 'bundles']) walk(p[k], k);
  return out;
}
export const isProductPageField = (f) => PRODUCT_PAGE_FIELDS.has(f);

// ---------- robots.txt
const robotsCache = new Map();
const sitemapCache = new Map();
async function robotsFor(origin) {
  if (robotsCache.has(origin)) return robotsCache.get(origin);
  const p = (async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(`${origin}/robots.txt`, { headers: { 'user-agent': W.userAgent }, signal: ctrl.signal });
      if (!res.ok) return () => true;
      const txt = await res.text();
      sitemapCache.set(origin, [...txt.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)].map((m) => m[1]));
      return parseRobots(txt);
    } catch {
      return () => true;
    } finally {
      clearTimeout(t);
    }
  })();
  robotsCache.set(origin, p);
  return p;
}
/** Sitemap URLs a site declares in robots.txt (empty when none). */
export async function sitemapsFor(origin) {
  await robotsFor(origin);
  return sitemapCache.get(origin) || [];
}

export function parseRobots(txt) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (!lastWasAgent) groups.push((cur = { agents: [], rules: [] }));
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && (key === 'allow' || key === 'disallow')) cur.rules.push({ allow: key === 'allow', path: val });
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && 'cdr-product-comparator'.includes(a)));
  const rules = (mine.length ? mine : groups.filter((g) => g.agents.includes('*'))).flatMap((g) => g.rules).filter((r) => r.path);
  const toRe = (p) => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
  const compiled = rules.map((r) => ({ ...r, re: toRe(r.path), len: r.path.length }));
  return (path) => {
    let best = null;
    for (const r of compiled) if (r.re.test(path) && (!best || r.len > best.len || (r.len === best.len && r.allow))) best = r;
    return !best || best.allow;
  };
}

// ---------- text and number extraction
const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", percnt: '%', dollar: '$', ndash: '-', mdash: '-' };
const decode = (s) =>
  s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });
function htmlToText(html) {
  return decode(
    html
      .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<br\s*\/?>|<\/(p|div|li|tr|td|th|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}
function htmlLinks(html, base) {
  const out = [];
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const u = new URL(decode(m[1]), base);
      if (!/^https?:$/.test(u.protocol)) continue;
      u.hash = '';
      out.push({ href: u.toString(), text: htmlToText(m[2]).slice(0, 120) });
    } catch {}
  }
  return out;
}
const titleOf = (html) => htmlToText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').slice(0, 140);

// Percentages: "6.24%", "6.24 % p.a.", "6.24 per cent", "6.24 p.a."
export function percentages(text) {
  const set = new Set();
  for (const m of text.matchAll(/(?<![\d.])(\d{1,2}(?:\.\d{1,4})?)\s*(?:%|per\s?cent|p\.?\s?a\.?)/gi)) {
    const n = Number(m[1]);
    if (n > 0 && n < 40) set.add(Math.round(n * 10000) / 10000);
  }
  return [...set].sort((a, b) => a - b).slice(0, 800);
}
// Dollar amounts: "$395", "$1,000.00", "AUD 5"
export function amounts(text) {
  const set = new Set();
  for (const m of text.matchAll(/(?:\$|AUD\s?)\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?/g)) {
    const n = Number(m[1].replace(/,/g, '') + (m[2] || ''));
    if (Number.isFinite(n)) set.add(Math.round(n * 100) / 100);
  }
  return [...set].sort((a, b) => a - b).slice(0, 800);
}

// In documents that cover several products (rate schedules, fee guides), keep the figures that
// appear in each product's own section: from a mention of its name up to the next product's name.
function sectionsByName(text, names) {
  if (!names?.length) return { byName: {}, mentionsAny: false };
  const lower = text.toLowerCase();
  const hits = [];
  for (const name of names) {
    const n = name.toLowerCase();
    for (let i = lower.indexOf(n); i !== -1 && hits.length < 4000; i = lower.indexOf(n, i + n.length)) hits.push({ name, at: i, end: i + n.length });
  }
  hits.sort((a, b) => a.at - b.at || b.end - a.end);
  const byName = {};
  hits.forEach((h, idx) => {
    let stop = Math.min(text.length, h.at + 3000);
    for (let j = idx + 1; j < hits.length; j++) if (hits[j].name !== h.name && hits[j].at >= h.end) { stop = Math.min(stop, hits[j].at); break; }
    const slice = text.slice(h.at, stop);
    const e = (byName[h.name] ??= { pct: new Set(), amt: new Set() });
    percentages(slice).forEach((x) => e.pct.add(x));
    amounts(slice).forEach((x) => e.amt.add(x));
  });
  for (const k of Object.keys(byName)) byName[k] = { pct: [...byName[k].pct], amt: [...byName[k].amt] };
  return { byName, mentionsAny: hits.length > 0 };
}

// Energy prices in cents: "31.35 c/kWh", "31.35c per kWh", "120.45 cents/day", "$0.3135/kWh", "$1.2045 per day"
export function cents(text) {
  const set = new Set();
  const t = text.replace(/\u00a2/g, 'c');
  for (const m of t.matchAll(/(?<![\d.])(\d{1,4}(?:\.\d{1,5})?)\s*(?:c|cents?)\s*(?:\/|per|a)\s*(?:kwh|day|mj|gj|kw)\b/gi)) set.add(Math.round(Number(m[1]) * 10000) / 10000);
  for (const m of t.matchAll(/\$\s?(\d{1,2}(?:\.\d{1,6})?)\s*(?:\/|per|a)\s*(?:kwh|day|mj|gj|kw)\b/gi)) set.add(Math.round(Number(m[1]) * 100 * 10000) / 10000);
  return [...set].filter((v) => v > 0 && v < 10000).sort((a, b) => a - b).slice(0, 1500);
}

// ---------- PDF text
let pdfjs;
async function pdfText(buf) {
  pdfjs ??= await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 }).promise;
  const parts = [];
  for (let i = 1; i <= Math.min(doc.numPages, W.maxPdfPages); i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    let line = '';
    for (const it of tc.items) {
      line += it.str + (it.hasEOL ? '\n' : ' ');
    }
    parts.push(line);
  }
  await doc.destroy();
  return parts.join('\n').replace(/[ \t]+/g, ' ');
}

// ---------- optional headless rendering for JavaScript-built pages
let browserP = null;
const renderLimit = semaphore(2);
async function render(url) {
  if (!W.render) return null;
  browserP ??= (async () => {
    try {
      const { chromium } = require('playwright');
      return await chromium.launch();
    } catch {
      return null;
    }
  })();
  const browser = await browserP;
  if (!browser) return null;
  return renderLimit(async () => {
    const page = await browser.newPage({ userAgent: W.userAgent });
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      const html = await page.content();
      webStats.rendered++;
      return html;
    } catch {
      return null;
    } finally {
      await page.close().catch(() => {});
    }
  });
}
export async function closeBrowser() {
  const b = await browserP;
  await b?.close().catch(() => {});
}

// ---------- one document
const BLOCK_MARKERS = /access denied|attention required|are you a robot|captcha|cf-chl|request unsuccessful\. incapsula|pardon our interruption|bot detection|akamai/i;

async function readBody(res, cap) {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > cap) {
      await reader.cancel().catch(() => {});
      throw Object.assign(new Error(`larger than ${Math.round(cap / 1e6)} MB`), { tooBig: true });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Fetch one page or PDF and extract what the checks need.
 * opts.keepText keeps the extracted text (capped); opts.raw keeps XML/plain-text bodies (sitemaps).
 */
export async function fetchDoc(url, deadline, names = [], opts = {}) {
  const r = { url, finalUrl: null, status: null, kind: null, ok: false, blocked: false, robots: false, skipped: false, error: null, textLen: 0, title: '', pct: [], amt: [], links: [], rendered: false, notHttps: false, homepage: false };
  let u;
  try {
    u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) throw new Error('not an http(s) URL');
  } catch (e) {
    r.error = `invalid URL (${e.message})`;
    return r;
  }
  r.notHttps = u.protocol === 'http:' && !/^(localhost|127\.0\.0\.1)$/.test(u.hostname);
  if (Date.now() > deadline) {
    r.skipped = true;
    webStats.skipped++;
    return r;
  }
  const allowed = await robotsFor(u.origin);
  if (!allowed(u.pathname + u.search)) {
    r.robots = true;
    webStats.robots++;
    return r;
  }
  return limitFor(u.host)(() =>
    globalLimit(async () => {
      if (Date.now() > deadline) {
        r.skipped = true;
        webStats.skipped++;
        return r;
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), W.timeoutMs);
      try {
        webStats.requests++;
        const res = await fetch(url, {
          headers: { 'user-agent': W.userAgent, accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.5', 'accept-language': 'en-AU,en;q=0.8' },
          redirect: 'follow',
          signal: ctrl.signal,
        });
        r.status = res.status;
        r.finalUrl = res.url || url;
        try {
          const f = new URL(r.finalUrl);
          r.homepage = res.redirected && (f.pathname === '/' || f.pathname === '') && !f.search && (new URL(url).pathname.length > 1);
        } catch {}
        const type = (res.headers.get('content-type') || '').toLowerCase();
        const isPdf = type.includes('pdf') || /\.pdf($|\?)/i.test(r.finalUrl);
        if ([401, 403, 429].includes(res.status) || (res.status === 503 && !isPdf)) {
          const body = (await readBody(res, 2e5).catch(() => Buffer.alloc(0))).toString('utf8');
          r.blocked = res.status !== 401 || BLOCK_MARKERS.test(body);
          if (r.blocked) webStats.blocked++;
          return r;
        }
        if (!res.ok) {
          res.body?.cancel().catch(() => {});
          return r;
        }
        if (isPdf) {
          r.kind = 'pdf';
          webStats.pdfs++;
          const buf = await readBody(res, W.maxPdfBytes);
          if (buf.subarray(0, 5).toString() !== '%PDF-') throw new Error('not a valid PDF');
          const text = await pdfText(buf);
          r.textLen = text.length;
          r.pct = percentages(text);
          r.amt = amounts(text);
          r.cents = cents(text);
          Object.assign(r, sectionsByName(text, names));
          if (opts.keepText) r.text = text.slice(0, 2e6);
          r.ok = true;
          return r;
        }
        if (opts.raw && (type.includes('xml') || type.includes('text/plain') || /\.xml($|\?)/i.test(r.finalUrl))) {
          r.kind = 'xml';
          r.raw = (await readBody(res, 3e7)).toString('utf8');
          r.textLen = r.raw.length;
          r.ok = true;
          return r;
        }
        if (type.includes('html') || !type) {
          r.kind = 'html';
          let html = (await readBody(res, W.maxHtmlBytes)).toString('utf8');
          if (BLOCK_MARKERS.test(html.slice(0, 5000)) && htmlToText(html).length < 1500) {
            r.blocked = true;
            webStats.blocked++;
            return r;
          }
          let text = htmlToText(html);
          if (text.length < 600) {
            const rendered = await render(r.finalUrl);
            if (rendered) {
              html = rendered;
              text = htmlToText(html);
              r.rendered = true;
            }
          }
          r.title = titleOf(html);
          r.textLen = text.length;
          r.pct = percentages(text);
          r.amt = amounts(text);
          r.cents = cents(text);
          Object.assign(r, sectionsByName(text, names));
          r.links = htmlLinks(html, r.finalUrl).slice(0, opts.maxLinks || 400);
          if (opts.keepText) r.text = text.slice(0, 2e6);
          r.ok = true;
          return r;
        }
        r.kind = 'other';
        res.body?.cancel().catch(() => {});
        r.ok = true;
        return r;
      } catch (e) {
        r.error = e.name === 'AbortError' ? `timed out after ${W.timeoutMs / 1000}s` : [e.message, e.cause?.code].filter(Boolean).join(' ');
        webStats.errors++;
        return r;
      } finally {
        clearTimeout(timer);
      }
    })
  );
}

// ---------- one bank
const DOC_LINK = /rate|fee|pricing|charges|schedule|terms|conditions|\bpds\b|disclosure|key[\s-]?fact|\btmd\b|target market|interest/i;
const MULTI_SUFFIX = /\.(com|net|org|gov|edu|asn|id)\.au$/;
export const site = (host) => {
  const parts = host.replace(/^www\./, '').split('.');
  return parts.slice(MULTI_SUFFIX.test(host) ? -3 : -2).join('.');
};

/**
 * Fetch every URL a bank's products point to, then rate/fee/terms pages and PDFs one click away.
 * @returns {{ docs: Map<string, object>, productUrls: Map<string, {url, field}[]>, children: Map<string, string[]> }}
 */
export async function readBrand(brand, rawProducts, keyOf, deadline) {
  const productUrls = new Map();
  const refs = new Map(); // url -> count of products
  for (const p of rawProducts) {
    const list = collectUris(p);
    productUrls.set(keyOf(p), list);
    for (const { url } of list) refs.set(url, (refs.get(url) || 0) + 1);
  }
  const urls = [...refs.keys()].sort((a, b) => refs.get(b) - refs.get(a)).slice(0, W.maxUrlsPerBrand);
  const names = [...new Set(rawProducts.map((p) => (p.name || '').trim()).filter((n) => n.length >= 6))];
  const docs = new Map();
  await Promise.all(urls.map(async (url) => docs.set(url, await fetchDoc(url, deadline, names))));
  for (const url of refs.keys()) if (!docs.has(url)) docs.set(url, { url, skipped: true, ok: false, pct: [], amt: [], links: [] });

  // One hop: rate sheets, fee schedules, PDS, key facts, terms, on the bank's own site
  const children = new Map();
  const queue = [];
  for (const d of docs.values()) {
    if (!d.ok || d.kind !== 'html') continue;
    const home = site(new URL(d.finalUrl || d.url).hostname);
    const picks = d.links
      .filter((l) => !docs.has(l.href) && site(new URL(l.href).hostname) === home && (/\.pdf($|\?)/i.test(l.href) || DOC_LINK.test(l.text) || DOC_LINK.test(new URL(l.href).pathname)))
      .sort((a, b) => Number(/\.pdf/i.test(b.href)) - Number(/\.pdf/i.test(a.href)))
      .slice(0, W.maxLinkedPerPage)
      .map((l) => l.href);
    children.set(d.url, [...new Set(picks)]);
    queue.push(...picks);
  }
  const linked = [...new Set(queue)].slice(0, W.maxLinkedDocsPerBrand);
  await Promise.all(linked.map(async (url) => docs.set(url, { ...(await fetchDoc(url, deadline, names)), linked: true })));
  for (const [parent, kids] of children) children.set(parent, kids.filter((k) => docs.has(k)));
  for (const d of docs.values()) d.links = undefined; // not needed downstream
  return { docs, productUrls, children, refs };
}
