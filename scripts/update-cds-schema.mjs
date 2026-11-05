#!/usr/bin/env node
// Refreshes the product schemas used by the standards checks from the official Consumer Data
// Standards OpenAPI files (ConsumerDataStandardsAustralia/standards on GitHub).
// Usage: node scripts/update-cds-schema.mjs [banking|energy|all] [path-or-url-to-spec]
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const RAW = 'https://raw.githubusercontent.com/ConsumerDataStandardsAustralia/standards/master/swagger-gen/api/';
const SECTORS = {
  banking: { file: 'cds_banking.json', out: 'banking-products.json', list: '/banking/products', detail: '/banking/products/{productId}', root: (v) => `ResponseBankingProductByIdV${v}` },
  energy: { file: 'cds_energy.json', out: 'energy-plans.json', list: '/energy/plans', detail: '/energy/plans/{planId}', root: (v) => `EnergyPlanResponseV${v}` },
};

async function build(name, src) {
  const cfg = SECTORS[name];
  const from = src || RAW + cfg.file;
  const spec = /^https?:/.test(from) ? await (await fetch(from)).json() : JSON.parse(await readFile(from, 'utf8'));
  const all = spec.components.schemas;
  const versionOf = (path) => Number(spec.paths[path]?.get?.['x-version'] ?? NaN);
  const detailVersion = versionOf(cfg.detail);
  const keep = {};
  const queue = [cfg.root(detailVersion)];
  while (queue.length) {
    const n = queue.pop();
    if (keep[n] || !all[n]) continue;
    keep[n] = all[n];
    JSON.stringify(all[n]).replace(/#\/components\/schemas\/([A-Za-z0-9_]+)/g, (_, x) => queue.push(x));
  }
  const slim = JSON.parse(JSON.stringify(keep, (k, v) => (k === 'description' && typeof v === 'string' ? v.replace(/\s+/g, ' ').slice(0, 160) : k === 'example' || k === 'examples' ? undefined : v)));
  const out = { source: `ConsumerDataStandardsAustralia/standards swagger-gen/api/${cfg.file}`, specVersion: spec.info.version, listVersion: versionOf(cfg.list), detailVersion, root: cfg.root(detailVersion), schemas: slim };
  await mkdir(new URL('../pipeline/cds/', import.meta.url), { recursive: true });
  await writeFile(new URL(`../pipeline/cds/${cfg.out}`, import.meta.url), JSON.stringify(out, null, 1));
  console.log(`${name}: CDS ${out.specVersion}, list v${out.listVersion}, detail v${out.detailVersion}, ${Object.keys(keep).length} schemas`);
}

const [which = 'all', src] = process.argv.slice(2);
for (const name of which === 'all' ? Object.keys(SECTORS) : [which]) await build(name, which === 'all' ? null : src);
