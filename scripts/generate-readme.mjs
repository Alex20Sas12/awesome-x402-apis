#!/usr/bin/env node
// Generates README.md from the public PayAPI Market catalogue.
// Node 20+ built-ins only.
//
// /agent/list does not expose health or pay-to status, so this generator
// does not filter on either. The "How APIs get on this list" section says so
// by omission: it does not claim a health check.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIST_URL = 'https://payapi.market/agent/list';
const MARKETPLACE_URL = 'https://payapi.market/marketplace';
const LISTING_URL = 'https://payapi.market/marketplace/';
const TOP_PICKS_PATH = path.join(ROOT, 'data', 'top-picks.json');
const MAX_PAGES = 50;
const MAX_ATTEMPTS = 3;
const PER_PROVIDER_CAP = 5;
const DESC_MAX = 100;
const HOUSE_PROVIDERS = new Set(['PayAPI Market', 'PayAPI House']);
const BAZAAR_PROVIDER = 'Unclaimed (bazaar)';
const TABLE_HEADER = ['API', 'What it does', 'Price/call (USDC)', 'Chains', 'Receipt'];
const DATE_LINE = /Updated: \d{4}-\d{2}-\d{2}/;

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
  return HOUSE_PROVIDERS.has(String(item?.provider_name ?? '').trim());
}

export function isBazaarImport(item) {
  return String(item?.provider_name ?? '').trim() === BAZAAR_PROVIDER;
}

// Directory imports and first-party listings stay out of the tables.
export function isExcluded(item) {
  return isBazaarImport(item) || isHouse(item);
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
    if (group.length > cap) {
      const slug = group.find((i) => i.provider_slug)?.provider_slug ?? null;
      more.push({ provider, count: group.length - cap, slug });
    }
  }
  more.sort((a, b) => cmp(a.provider, b.provider));
  return { kept, more };
}

const escapeCell = (text) =>
  String(text)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');

// Numeric ranges keep their meaning. Other em and en dashes become a comma.
export function replaceDashes(text) {
  return String(text ?? '')
    .replace(/\u2026/g, '...')
    .replace(/(\d(?:\.\d+)?)\s*[\u2013\u2014]\s*(\d(?:\.\d+)?)/g, '$1 to $2')
    .replace(/[\u2013\u2014]/g, ', ');
}

export function stripDashes(text) {
  return replaceDashes(text)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+,/g, ',')
    .replace(/,\s*,+/g, ',')
    .replace(/^,\s*/, '')
    .trim();
}

export function trimDescription(text, max = DESC_MAX) {
  const flat = stripDashes(String(text ?? '').replace(/\s+/g, ' '));
  if (flat.length <= max) return flat;
  const ellipsis = '...';
  const cut = flat.slice(0, Math.max(0, max - ellipsis.length));
  const lastSpace = cut.lastIndexOf(' ');
  const base = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.]+$/, '');
  return `${base}${ellipsis}`;
}

function formatNumber(n) {
  return Number(n).toFixed(6).replace(/\.?0+$/, '');
}

export function formatPrice(min, max) {
  const hasMin = typeof min === 'number' && Number.isFinite(min);
  const hasMax = typeof max === 'number' && Number.isFinite(max);
  if (!hasMin && !hasMax) return '';
  const lo = hasMin ? min : max;
  const hi = hasMax ? max : min;
  return lo === hi ? formatNumber(lo) : `${formatNumber(lo)} to ${formatNumber(hi)}`;
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
  return labels.join(', ');
}

const escapeLinkText = (text) => stripDashes(text).replace(/([[\]])/g, '\\$1');

function listingLink(item, sharedUrls) {
  if (item.marketplace_url && sharedUrls.has(item.marketplace_url)) {
    return `${LISTING_URL}${item.id}`;
  }
  return item.marketplace_url;
}

// Rows that share a marketplace_url get a per-id link so every row stays unique.
export function renderRow(item, sharedUrls = new Set()) {
  const name = escapeCell(stripDashes(item.name));
  const linkedName = `[${name}](${listingLink(item, sharedUrls)})`;
  const receipt = (item.verified_routes ?? []).map((r) => r.receipt_url).find(Boolean);
  return [
    linkedName,
    escapeCell(trimDescription(item.description)),
    formatPrice(item.price_min, item.price_max),
    escapeCell(formatChains(item)),
    receipt ? `[tx](${receipt})` : '',
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

export function loadTopPicks(file = TOP_PICKS_PATH) {
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (Array.isArray(parsed)) return parsed;
  return parsed.categories ?? [];
}

function renderTopPicks(categories) {
  const lines = [];
  for (const category of categories) {
    const links = [];
    for (const api of category.apis ?? []) {
      if (!api?.name || !api?.url) continue;
      links.push(`[${escapeLinkText(api.name)}](${api.url})`);
    }
    if (!links.length) continue;
    lines.push(`- **${stripDashes(category.name)}:** ${links.join(', ')}`);
  }
  if (!lines.length) return [];
  return [
    '## Top picks',
    '',
    'Six per category. Full method: [payapi.market/best-x402-apis-2027](https://payapi.market/best-x402-apis-2027).',
    '',
    ...lines,
    '',
  ];
}

const categoryOf = (item) => stripDashes(item.category || 'Uncategorised') || 'Uncategorised';

function capPerCategory(items) {
  const groups = new Map();
  for (const item of items) {
    const cat = categoryOf(item);
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(item);
  }
  const categories = [...groups.keys()].sort(cmp);
  const byCategory = new Map();
  const kept = [];
  const moreMap = new Map();
  for (const cat of categories) {
    const { kept: catKept, more } = applyProviderCap(groups.get(cat));
    byCategory.set(cat, catKept);
    kept.push(...catKept);
    for (const entry of more) {
      const prev = moreMap.get(entry.provider);
      if (prev) prev.count += entry.count;
      else moreMap.set(entry.provider, { ...entry });
    }
  }
  const more = [...moreMap.values()].sort((a, b) => cmp(stripDashes(a.provider), stripDashes(b.provider)));
  return { categories, byCategory, kept, more };
}

function howApisSection() {
  return [
    '## How APIs get on this list',
    '',
    'An API appears in the category tables only if, when the list was generated, it was:',
    '',
    '1. live on PayAPI Market and settlement-verified: PayAPI paid one of its routes from its own wallet, received real output and recorded the on-chain USDC receipt (the "tx" link);',
    '2. listed by an independent provider. Directory imports whose providers have not signed up ("Unclaimed (bazaar)") and first-party PayAPI Market and PayAPI House listings are not included.',
    '',
    'Each provider shows at most five APIs in each table. Verification covers the paid route, not every route of an API, and is not an endorsement. The tables are regenerated from the public catalogue at `https://payapi.market/agent/list`.',
    '',
    'Data report: [The x402 API market: a snapshot from PayAPI Market, October 2026 (Zenodo, DOI 10.5281/zenodo.23658608)](https://doi.org/10.5281/zenodo.23658608).',
    '',
  ];
}

export function renderReadme(listings, { date, externalMd = '', topPicks } = {}) {
  const eligible = cleanListings(listings).filter((item) => !isExcluded(item));
  const { categories, byCategory, kept, more } = capPerCategory(eligible);
  const picks = topPicks ?? loadTopPicks();

  const urlCounts = new Map();
  for (const item of kept) urlCounts.set(item.marketplace_url, (urlCounts.get(item.marketplace_url) ?? 0) + 1);
  const sharedUrls = new Set([...urlCounts].filter(([, n]) => n > 1).map(([u]) => u));

  const contents = [];
  if (picks.length) contents.push('Top picks');
  for (const cat of categories) contents.push(cat);
  if (more.length) contents.push('More from these providers');
  contents.push(
    'Other x402 APIs',
    'Developer tools and SDKs',
    'How APIs get on this list',
    'Add your API',
    'Licence',
  );

  const out = [];
  // "X402" is title case so awesome-lint accepts the heading. Body text keeps "x402".
  out.push('# Awesome X402 APIs [![Awesome](https://awesome.re/badge.svg)](https://awesome.re)');
  out.push('');
  // Repeated listing URLs (top picks and category tables) and the CC0 section are intentional.
  out.push('<!--lint disable double-link awesome-license awesome-list-item-->');
  out.push('');
  out.push(
    '[![Licence: CC0-1.0](https://img.shields.io/badge/licence-CC0--1.0-lightgrey.svg)](LICENSE) [![Settlement-verified](https://img.shields.io/badge/listings-settlement--verified-2ea44f.svg)](https://payapi.market/marketplace) [![Pay in USDC](https://img.shields.io/badge/pay-USDC%20on%20Base%2C%20Solana%20or%20Algorand-0052ff.svg)](https://payapi.market/agents)',
  );
  out.push('');
  out.push(
    '> The best x402 APIs are pay-per-call APIs that an AI agent can pay in USDC over HTTP 402 and be sure of getting a real result. This list includes only x402 APIs that [PayAPI Market](https://payapi.market) has paid itself and received genuine output from, each with an on-chain receipt anyone can check.',
  );
  out.push('');
  out.push(
    `Updated: ${date}. Agents pay per call in USDC on Base, Solana or Algorand, with no API key or account. Each API links to its PayAPI Market listing, where you will find the endpoint, price and settlement receipt.`,
  );
  out.push('');
  out.push('## Contents');
  out.push('');
  for (const c of contents) out.push(`- [${c}](#${slug(c)})`);
  out.push('');

  out.push(...renderTopPicks(picks));

  for (const cat of categories) {
    out.push(`## ${cat}`);
    out.push('');
    const items = byCategory
      .get(cat)
      .slice()
      .sort((a, b) => cmp(stripDashes(a.name), stripDashes(b.name)) || cmp(a.id, b.id));
    out.push(...renderTable(TABLE_HEADER, items.map((item) => renderRow(item, sharedUrls))));
    out.push('');
  }

  if (more.length) {
    out.push('## More from these providers');
    out.push('');
    out.push(
      `Providers with more than five qualifying APIs. The rest are on [payapi.market/marketplace](${MARKETPLACE_URL}).`,
    );
    out.push('');
    for (const { provider, count } of more) {
      out.push(`- ${stripDashes(provider)}: ${count} more`);
    }
    out.push('');
  }

  out.push('## Other x402 APIs');
  out.push('');
  out.push(replaceDashes(externalMd.trim()));
  out.push('');
  out.push('## Developer tools and SDKs');
  out.push('');
  out.push(
    'SDKs, facilitators and developer tools are listed in [xpaysh/awesome-x402](https://github.com/xpaysh/awesome-x402). Protocol documentation is at [x402.org](https://x402.org).',
  );
  out.push('');
  out.push(...howApisSection());
  out.push('## Add your API');
  out.push('');
  out.push(
    'List it free at [payapi.market/providers](https://payapi.market/providers). There is no fee and no plan to choose: agents pay your endpoint directly and you keep 100%. Once a test payment settles and the API meets the rules above, it appears here at the next regeneration. For x402 APIs you do not want on PayAPI Market, open a pull request against `data/external.md` as described in [CONTRIBUTING.md](CONTRIBUTING.md).',
  );
  out.push('');
  out.push('## Licence');
  out.push('');
  out.push(
    '[![CC0](https://licensebuttons.net/p/zero/1.0/88x31.png)](https://creativecommons.org/publicdomain/zero/1.0/)',
  );
  out.push('');
  out.push(
    'To the extent possible under law, PayAPI Market has waived all copyright and related rights to this list. See [LICENSE](LICENSE).',
  );
  out.push('');

  const text = out.join('\n');
  if (/[\u2013\u2014]/.test(text)) {
    throw new Error('Generated README contains an en dash or em dash');
  }
  return text;
}

const stripDate = (text) => text.replace(DATE_LINE, 'Updated: DATE');

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
