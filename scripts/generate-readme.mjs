#!/usr/bin/env node
// Generates README.md from the public PayAPI Market catalogue.
// Node 20+ built-ins only.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIST_URL = 'https://payapi.market/agent/list';
const PROVIDER_URL = 'https://payapi.market/provider/';
const LISTING_URL = 'https://payapi.market/marketplace/';
const MAX_PAGES = 50;
const MAX_ATTEMPTS = 3;
const PER_PROVIDER_CAP = 5;
const DESC_MAX = 100;
const HOUSE_PROVIDERS = new Set(['PayAPI Market', 'PayAPI House']);
const TABLE_HEADER = ['API', 'What it does', 'Price/call', 'Chains', 'Verified', 'Listing'];
const DATE_LINE = /^Last generated: \d{4}-\d{2}-\d{2} \(UTC\)/m;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchPage(url, { fetchFn, delay }) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetchFn(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const body = await res.json();
      if (!body || !Array.isArray(body.results)) {
        throw new Error(`Unexpected response shape for ${url}`);
      }
      return body;
    } catch (err) {
      lastError = err;
      if (attempt < MAX_ATTEMPTS) await delay(500 * 2 ** (attempt - 1));
    }
  }
  throw new Error(`Page failed after ${MAX_ATTEMPTS} attempts: ${lastError.message}`);
}

export async function fetchAllListings({ fetchFn = fetch, delay = sleep, baseUrl = LIST_URL } = {}) {
  const all = [];
  let url = `${baseUrl}?verified_only=true&limit=100&offset=0`;
  for (let page = 1; ; page++) {
    if (page > MAX_PAGES) throw new Error(`Hit the ${MAX_PAGES}-page limit; refusing to continue`);
    const body = await fetchPage(url, { fetchFn, delay });
    all.push(...body.results);
    if (!body.has_more) break;
    if (!body.next_cursor) throw new Error('has_more is true but next_cursor is missing');
    url = `${baseUrl}?verified_only=true&limit=100&cursor=${encodeURIComponent(body.next_cursor)}`;
  }
  return all;
}

export function cleanListings(raw) {
  const byId = new Map();
  for (const item of raw) {
    if (!item || !item.id || byId.has(item.id)) continue;
    if (item.payment_verified !== true || item.status !== 'live') continue;
    byId.set(item.id, item);
  }
  return [...byId.values()];
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function isHouse(item) {
  return HOUSE_PROVIDERS.has(item.provider_name);
}

export function applyProviderCap(items, cap = PER_PROVIDER_CAP) {
  const groups = new Map();
  for (const item of items) {
    const key = item.provider_name ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const kept = [];
  const more = [];
  for (const [provider, group] of groups) {
    group.sort(
      (a, b) =>
        (b.verified_route_count ?? 0) - (a.verified_route_count ?? 0) ||
        (b.reliability?.score ?? 0) - (a.reliability?.score ?? 0) ||
        cmp(a.name, b.name) ||
        cmp(a.id, b.id),
    );
    kept.push(...group.slice(0, cap));
    if (group.length > cap) more.push({ provider, count: group.length - cap });
  }
  more.sort((a, b) => cmp(a.provider, b.provider));
  return { kept, more };
}

const escapeCell = (text) =>
  String(text).replace(/\s+/g, ' ').trim().replace(/\\/g, '\\\\').replace(/\|/g, '\\|');

export function trimDescription(text, max = DESC_MAX) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  const base = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  return `${base.replace(/[\s,;:.\-–]+$/, '')}…`;
}

function formatNumber(n) {
  return Number(n).toFixed(6).replace(/\.?0+$/, '');
}

export function formatPrice(min, max) {
  const hasMin = typeof min === 'number' && Number.isFinite(min);
  const hasMax = typeof max === 'number' && Number.isFinite(max);
  if (!hasMin && !hasMax) return '—';
  const lo = hasMin ? min : max;
  const hi = hasMax ? max : min;
  return lo === hi ? `$${formatNumber(lo)}` : `$${formatNumber(lo)}–${formatNumber(hi)}`;
}

const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function formatChains(item) {
  const labels = [];
  for (const n of item.networks ?? []) {
    if (!(n.settlement_verified || n.advertised)) continue;
    const label = n.label || (n.key ? titleCase(n.key) : '');
    if (label && !labels.includes(label)) labels.push(label);
  }
  if (labels.length === 0 && item.network) labels.push(titleCase(item.network));
  return labels.length ? labels.join(', ') : '—';
}

// Linking the full base_url (not just the origin) keeps links unique per API,
// which awesome-lint's double-link rule requires when a provider has several APIs.
function siteLink(item) {
  try {
    return new URL(item.base_url).href;
  } catch {
    return item.marketplace_url;
  }
}

export function providerSlug(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Rows that share a marketplace_url get a per-id link so every row stays unique.
export function renderRow(item, sharedUrls = new Set()) {
  const listingUrl = sharedUrls.has(item.marketplace_url)
    ? `${LISTING_URL}${item.id}`
    : item.marketplace_url;
  const name = escapeCell(item.name).replace(/([[\]])/g, '\\$1') + (isHouse(item) ? ' (house)' : '');
  const linkedName = `[${name}](${siteLink(item)})`;
  const receipt = (item.verified_routes ?? []).map((r) => r.receipt_url).find(Boolean);
  const verified = receipt ? `✅ [tx](${receipt})` : '✅';
  return [
    linkedName,
    escapeCell(trimDescription(item.description)),
    formatPrice(item.price_min, item.price_max),
    escapeCell(formatChains(item)),
    verified,
    `[payapi](${listingUrl})`,
  ];
}

// Pads cells so pipes line up (awesome-lint's table-pipe-alignment rule).
export function renderTable(header, rows) {
  const width = (text) => [...text].length;
  const widths = header.map((h, i) => Math.max(3, width(h), ...rows.map((r) => width(r[i]))));
  const line = (cells) =>
    `| ${cells.map((c, i) => c + ' '.repeat(widths[i] - width(c))).join(' | ')} |`;
  return [line(header), `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`, ...rows.map(line)];
}

const slug = (heading) => heading.toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-');

export function renderReadme(listings, { date, externalMd = '' }) {
  const verified = cleanListings(listings);
  const providers = new Set(verified.map((i) => i.provider_name ?? ''));
  const { kept, more } = applyProviderCap(verified);

  const byCategory = new Map();
  for (const item of kept) {
    const cat = item.category || 'Uncategorised';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(item);
  }
  const categories = [...byCategory.keys()].sort(cmp);
  const urlCounts = new Map();
  for (const item of kept) urlCounts.set(item.marketplace_url, (urlCounts.get(item.marketplace_url) ?? 0) + 1);
  const sharedUrls = new Set([...urlCounts].filter(([, n]) => n > 1).map(([u]) => u));

  const contents = categories.map((c) => c);
  if (more.length) contents.push('More from these providers');
  contents.push('Other x402 APIs', 'Developer tools and SDKs');

  const out = [];
  out.push('# Awesome X402 APIs [![Awesome](https://awesome.re/badge.svg)](https://awesome.re)');
  out.push('');
  out.push('> Pay-per-request APIs that accept x402 payments, each with an on-chain test payment.');
  out.push('');
  out.push(
    `Last generated: ${date} (UTC) · ${verified.length} verified APIs from ${providers.size} providers`,
  );
  out.push('');
  out.push(
    "Maintained by PayAPI Market. Listings come from payapi.market's public catalogue; only APIs with a settled on-chain test payment appear in the tables. Each provider shows at most 5 APIs. APIs tagged (house) are operated by PayAPI Market.",
  );
  out.push('');
  out.push('## Contents');
  out.push('');
  for (const c of contents) out.push(`- [${c}](#${slug(c)})`);
  out.push('');

  for (const cat of categories) {
    out.push(`## ${cat}`);
    out.push('');
    const items = byCategory.get(cat).sort((a, b) => cmp(a.name, b.name) || cmp(a.id, b.id));
    out.push(...renderTable(TABLE_HEADER, items.map((item) => renderRow(item, sharedUrls))));
    out.push('');
  }

  if (more.length) {
    out.push('## More from these providers');
    out.push('');
    for (const { provider, count } of more) {
      const url = `${PROVIDER_URL}${providerSlug(provider)}`;
      out.push(`- ${provider}: [+${count} more on payapi.market](${url})`);
    }
    out.push('');
  }

  out.push('## Other x402 APIs');
  out.push('');
  out.push(externalMd.trim());
  out.push('');
  out.push('## Developer tools and SDKs');
  out.push('');
  out.push(
    'SDKs, facilitators and developer tools are listed in [xpaysh/awesome-x402](https://github.com/xpaysh/awesome-x402). Protocol documentation is at [x402.org](https://x402.org).',
  );
  out.push('');
  out.push('## Contributing');
  out.push('');
  out.push('See [CONTRIBUTING.md](CONTRIBUTING.md).');
  out.push('');
  return out.join('\n');
}

const stripDate = (text) => text.replace(DATE_LINE, 'Last generated: DATE (UTC)');

function parseArgs(argv) {
  const args = { input: null, check: false, date: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input') args.input = argv[++i];
    else if (argv[i] === '--check') args.check = true;
    else if (argv[i] === '--date') args.date = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const readmePath = path.join(ROOT, 'README.md');
  const externalPath = path.join(ROOT, 'data', 'external.md');

  let raw;
  if (args.input) {
    const parsed = JSON.parse(readFileSync(args.input, 'utf8'));
    raw = Array.isArray(parsed) ? parsed : parsed.results;
  } else {
    raw = await fetchAllListings();
  }

  const externalMd = existsSync(externalPath) ? readFileSync(externalPath, 'utf8') : '';
  const date = args.date ?? new Date().toISOString().slice(0, 10);
  const next = renderReadme(raw, { date, externalMd });
  const current = existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : '';
  const unchanged = stripDate(current) === stripDate(next);

  if (args.check) {
    if (unchanged) return 0;
    console.error('README.md is out of date');
    return 1;
  }
  if (unchanged) {
    console.log('no changes');
    return 0;
  }
  writeFileSync(readmePath, next);
  console.log('README.md written');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err.message);
      process.exit(1);
    },
  );
}
