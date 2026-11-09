#!/usr/bin/env node
// Static pages that sit beside the single-page app: the privacy page, the weekly brief's index,
// its RSS feed (which the email provider reads to send each brief), a sitemap and robots.txt.
// Settings come from site/site.json. Run: node pipeline/site-pages.mjs
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { newsletterReady, signupBox } from '../site/signup.js';
export { newsletterReady, signupBox };

export const SITE = new URL('../site/', import.meta.url).pathname;

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const longDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

export async function siteConfig() {
  const c = JSON.parse(await readFile(join(SITE, 'site.json'), 'utf8'));
  c.siteUrl = String(c.siteUrl || '').replace(/\/+$/, '');
  return c;
}

const LOGO = `<svg class="logo" width="34" height="34" viewBox="0 0 34 34" aria-hidden="true"><defs><clipPath id="logo-left"><circle cx="13" cy="17" r="9.5" /></clipPath></defs><circle cx="21" cy="17" r="9.5" class="logo-lens" clip-path="url(#logo-left)" /><circle cx="13" cy="17" r="9.5" class="logo-ring" /><circle cx="21" cy="17" r="9.5" class="logo-ring" /></svg>`;

/** A complete page in the site's style. `root` is the relative path back to the site root, e.g. '../../'. */
export function page({ c, root, path, title, description, body, noindex = false, current = '' }) {
  const canonical = `${c.siteUrl}/${path}`;
  const nav = [
    ['Home', `${root}#home`, ''],
    ['Electricity', `${root}#electricity`, ''],
    ['Gas', `${root}#gas`, ''],
    ['Weekly brief', `${root}brief/`, 'brief'],
    ['About', `${root}#about`, ''],
  ]
    .map(([t, h, k]) => `<a href="${h}"${k && k === current ? ' aria-current="page"' : ''}>${t}</a>`)
    .join('');
  return `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
${noindex ? '<meta name="robots" content="noindex, nofollow" />' : `<link rel="canonical" href="${esc(canonical)}" />`}
<link rel="alternate" type="application/rss+xml" title="OpenCompare weekly energy brief" href="${root}brief/rss.xml" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:type" content="article" />
<meta property="og:url" content="${esc(canonical)}" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="${root}styles.css" />
</head>
<body>
<header class="top"><div class="wrap top-inner">
<a class="brandmark" href="${root}#home" aria-label="OpenCompare, home">${LOGO}<span class="wordmark"><span class="wm-name">OpenCompare</span><span class="wm-sub">Independent comparisons from official open data</span></span></a>
<nav class="menu" aria-label="Main">${nav}</nav>
</div></header>
<main class="wrap static-page">
${body}
</main>
<footer class="wrap foot"><p>Prices are as published by each energy retailer through the Consumer Data Right and may differ from what you're offered. General information only; check a plan's fact sheet before switching. <a href="${root}privacy/">Privacy</a></p></footer>
</body>
</html>
`;
}

// ---- privacy page (change PRIVACY_UPDATED whenever its wording changes)
const PRIVACY_UPDATED = '2026-11-09';
function privacyBody(c) {
  const n = c.newsletter || {};
  const who = c.operator ? `${esc(c.operator)}${c.abn ? ` (ABN ${esc(c.abn)})` : ''}` : 'the operator of OpenCompare';
  const contact = c.contactEmail ? `<a href="mailto:${esc(c.contactEmail)}">${esc(c.contactEmail)}</a>` : 'the contact address on this page (being set up)';
  return `<article class="prose">
<h1>Privacy</h1>
<p class="muted">OpenCompare is run by ${who}. This page explains what information the site collects and what happens to it.</p>
<h2>Using the site</h2>
<p>You don't need an account. Postcodes, usage figures and other details you enter in the plan finders are used in your own browser to work out results; they aren't sent to us or stored by us. We don't use advertising or analytics trackers, and we don't set cookies.</p>
<p>The site is hosted on GitHub Pages, which, like any web host, receives your IP address and browser details when you load a page, under <a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement" target="_blank" rel="noopener">GitHub's privacy statement</a>. The site's fonts are loaded from Google Fonts, which receives the same technical details under <a href="https://policies.google.com/privacy" target="_blank" rel="noopener">Google's privacy policy</a>.</p>
<h2>The weekly email</h2>
${
  newsletterReady(c)
    ? `<p>If you subscribe to the weekly brief, your email address is collected and stored by our email provider, ${esc(n.provider)}${n.providerPrivacyUrl ? ` (<a href="${esc(n.providerPrivacyUrl)}" target="_blank" rel="noopener">their privacy policy</a>)` : ''}, which may store it outside Australia. We use it only to send the brief and messages about it. We don't sell or share it. You'll be asked to confirm your subscription, every email includes an unsubscribe link, and you can ask us to delete your address at any time.</p>`
    : `<p>An email version of the weekly brief is being set up. Until then, no email addresses are collected.</p>`
}
<h2>Questions, corrections and complaints</h2>
<p>Contact ${contact}. If you're not satisfied with our response, you can contact the <a href="https://www.oaic.gov.au/privacy/privacy-complaints" target="_blank" rel="noopener">Office of the Australian Information Commissioner</a>.</p>
<p class="small muted">Last updated ${longDate(PRIVACY_UPDATED)}.</p>
</article>`;
}

// ---- brief index, RSS, sitemap
async function readIndex() {
  try {
    return JSON.parse(await readFile(join(SITE, 'data', 'brief', 'index.json'), 'utf8'));
  } catch {
    return { briefs: [] };
  }
}

function briefIndexBody(c, published) {
  const list = published.length
    ? `<ul class="brief-list">${published
        .map((b) => `<li><a href="${b.date}/"><span class="bl-date">${longDate(b.date)}</span><span class="bl-title">${esc(b.title)}</span></a><p class="muted small">${esc(b.lead)}</p></li>`)
        .join('')}</ul>`
    : `<p class="muted">The first brief will appear here soon.</p>`;
  return `<article class="prose"><h1>Weekly energy brief</h1>
<p class="lede">Every Monday: what changed in Australian energy prices over the past week, worked out from every plan retailers publish under the Consumer Data Right.</p>
${signupBox(c, '../')}
${list}
<p class="small muted"><a href="rss.xml">RSS feed</a></p></article>`;
}

const rfc822 = (iso) => new Date(`${iso}T06:00:00+11:00`).toUTCString();
function rss(c, published, contentByDate) {
  const items = published
    .slice(0, 20)
    .map((b) => {
      const url = `${c.siteUrl}/brief/${b.date}/`;
      return `<item><title>${esc(b.title)}</title><link>${esc(url)}</link><guid isPermaLink="true">${esc(url)}</guid><pubDate>${rfc822(b.date)}</pubDate><description>${esc(b.lead)}</description>${contentByDate.has(b.date) ? `<content:encoded><![CDATA[${contentByDate.get(b.date).replace(/]]>/g, ']]&gt;')}]]></content:encoded>` : ''}</item>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
<title>OpenCompare weekly energy brief</title>
<link>${esc(c.siteUrl)}/brief/</link>
<description>What changed in Australian energy prices this week, from every plan published under the Consumer Data Right.</description>
<language>en-au</language>
${items}
</channel>
</rss>
`;
}

export async function buildPages({ log = console.log } = {}) {
  const c = await siteConfig();
  const index = await readIndex();
  const published = index.briefs.filter((b) => b.published).sort((a, b) => (a.date < b.date ? 1 : -1));
  await mkdir(join(SITE, 'privacy'), { recursive: true });
  await mkdir(join(SITE, 'brief'), { recursive: true });
  await writeFile(join(SITE, 'privacy', 'index.html'), page({ c, root: '../', path: 'privacy/', title: 'Privacy | OpenCompare', description: 'What information OpenCompare collects and how it is used.', body: privacyBody(c) }));
  await writeFile(join(SITE, 'brief', 'index.html'), page({ c, root: '../', path: 'brief/', title: 'Weekly energy brief | OpenCompare', description: 'Every Monday: what changed in Australian energy prices over the past week.', body: briefIndexBody(c, published), current: 'brief' }));
  const content = new Map();
  for (const b of published.slice(0, 20)) {
    try {
      content.set(b.date, await readFile(join(SITE, 'brief', b.date, 'email.html'), 'utf8'));
    } catch {}
  }
  await writeFile(join(SITE, 'brief', 'rss.xml'), rss(c, published, content));
  const urls = ['', 'brief/', 'privacy/', ...published.map((b) => `brief/${b.date}/`)];
  await writeFile(
    join(SITE, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `<url><loc>${esc(`${c.siteUrl}/${u}`)}</loc></url>`).join('\n')}\n</urlset>\n`
  );
  const base = new URL(c.siteUrl).pathname.replace(/\/+$/, '');
  await writeFile(join(SITE, 'robots.txt'), `User-agent: *\nDisallow: ${base}/brief/preview/\nSitemap: ${c.siteUrl}/sitemap.xml\n`);
  log(`Static pages: privacy, brief index (${published.length} published), RSS, sitemap; email sign-up ${newsletterReady(c) ? 'on' : 'off (not set up in site/site.json)'}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await buildPages();
