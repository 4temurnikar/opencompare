#!/usr/bin/env node
// Rebuilds pipeline/energy/retailers.json from the AER's published list of energy retailer
// base URIs (a PDF). Usage: node scripts/update-energy-retailers.mjs <url-or-path-to-pdf>
// The AER republishes the list from time to time; find the latest on aer.gov.au by searching
// "Consumer Data Right - Energy Retailer Base URIs and CDR Brands".
import { readFile, writeFile } from 'node:fs/promises';

const src = process.argv[2];
if (!src) {
  console.error('Usage: node scripts/update-energy-retailers.mjs <url-or-path-to-AER-pdf>');
  process.exit(1);
}
const buf = /^https?:/.test(src) ? Buffer.from(await (await fetch(src)).arrayBuffer()) : await readFile(src);
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, verbosity: 0 }).promise;
let text = '';
for (let i = 1; i <= doc.numPages; i++) {
  const tc = await (await doc.getPage(i)).getTextContent();
  text += tc.items.map((it) => it.str + (it.hasEOL ? '\n' : ' ')).join('') + '\n';
}
// Rows look like: "<Retailer name> <cdr-brand> https://cdr.energymadeeasy.gov.au/<path>/"
const rows = [];
for (const m of text.replace(/[ \t]+/g, ' ').matchAll(/([^\n]+?)\s+([a-z0-9][a-z0-9-]*)\s+(https:\/\/cdr\.energymadeeasy\.gov\.au\/[a-z0-9-]+\/?)/g)) {
  const name = m[1].replace(/^.*\b(Retailer|Base URI|CDR Brand)\b\s*/i, '').trim();
  if (name) rows.push({ name, brand: m[2], baseUri: m[3].replace(/\/$/, '') });
}
const unique = [...new Map(rows.map((r) => [r.brand, r])).values()];
if (unique.length < 40) {
  console.error(`Only found ${unique.length} rows; the PDF layout may have changed. Not overwriting.`);
  process.exit(1);
}
await writeFile(new URL('../pipeline/energy/retailers.json', import.meta.url), JSON.stringify({ source: 'AER energy retailer base URIs', sourceUrl: src, retailers: unique }, null, 1));
console.log(`Wrote ${unique.length} retailers (${new Set(unique.map((r) => r.baseUri)).size} feeds)`);
