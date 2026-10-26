import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  fetchAllListings,
  cleanListings,
  applyProviderCap,
  renderReadme,
  formatPrice,
  trimDescription,
  isExcluded,
} from '../scripts/generate-readme.mjs';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/listings.json', import.meta.url), 'utf8'),
).results;
const DATE = '2026-10-13';
const noDelay = async () => {};

function pagedFetch(pages, { failPage = -1 } = {}) {
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(url);
    const cursor = new URL(url).searchParams.get('cursor');
    const index = cursor ? Number(cursor.replace('c', '')) : 0;
    if (index === failPage) return { ok: false, status: 500, json: async () => ({}) };
    const results = pages[index];
    const hasMore = index < pages.length - 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ results, has_more: hasMore, next_cursor: hasMore ? `c${index + 1}` : null }),
    };
  };
  return { fetchFn, urls };
}

test('paging follows next_cursor and stops when has_more is false', async () => {
  const { fetchFn, urls } = pagedFetch([[fixture[0]], [fixture[1]], [fixture[2]]]);
  const all = await fetchAllListings({ fetchFn, delay: noDelay });
  assert.equal(all.length, 3);
  assert.equal(urls.length, 3);
  assert.match(urls[0], /limit=100&offset=0/);
  assert.match(urls[1], /cursor=c1/);
  assert.match(urls[2], /cursor=c2/);
});

test('paging throws at the 50-page limit', async () => {
  const fetchFn = async () => ({
    ok: true,
    json: async () => ({ results: [], has_more: true, next_cursor: 'again' }),
  });
  await assert.rejects(fetchAllListings({ fetchFn, delay: noDelay }), /page limit/);
});

test('a failed page retries 3 times then throws, so nothing can be written', async () => {
  const { fetchFn, urls } = pagedFetch([[fixture[0]], [fixture[1]]], { failPage: 1 });
  await assert.rejects(fetchAllListings({ fetchFn, delay: noDelay }), /failed after 3 attempts/);
  assert.equal(urls.filter((u) => u.includes('cursor=c1')).length, 3);
});

test('unverified and non-live rows are excluded, duplicates removed', () => {
  const cleaned = cleanListings([...fixture, fixture[0]]);
  assert.equal(cleaned.length, fixture.length - 2);
  assert.ok(!cleaned.some((i) => i.id === 'u1' || i.id === 'd1'));
  const readme = renderReadme(fixture, { date: DATE });
  assert.ok(!readme.includes('Unverified Thing'));
  assert.ok(!readme.includes('Dead Thing'));
});

test('Unclaimed (bazaar) rows and first-party listings are excluded', () => {
  assert.equal(isExcluded({ provider_name: 'Unclaimed (bazaar)' }), true);
  assert.equal(isExcluded({ provider_name: 'PayAPI Market' }), true);
  assert.equal(isExcluded({ provider_name: 'PayAPI House' }), true);
  assert.equal(isExcluded({ provider_name: 'Unclaimed' }), false);
  const readme = renderReadme(fixture, { date: DATE });
  assert.ok(!readme.includes('Bazaar Ghost API'));
  assert.ok(!readme.includes('House Oracle'));
  assert.ok(!readme.includes('House Calendar'));
  assert.ok(!readme.includes('(house)'));
  assert.match(readme, /Unclaimed \(bazaar\)/);
  assert.match(readme, /PayAPI House/);
});

test('cap keeps 5 per provider by routes, then reliability, then name', () => {
  const { kept, more } = applyProviderCap(cleanListings(fixture));
  const acme = kept.filter((i) => i.provider_name === 'Acme Data').map((i) => i.name);
  assert.deepEqual(acme, ['Acme Alpha', 'Acme Golf', 'Acme Bravo', 'Acme Charlie', 'Acme Delta']);
  assert.deepEqual(more, [{ provider: 'Acme Data', count: 2, slug: null }]);
});

test('cap is five rows per provider per table', () => {
  const items = [];
  for (let i = 0; i < 6; i++) {
    items.push({
      ...fixture[0],
      id: `d${i}`,
      name: `Data ${i}`,
      category: 'Data',
      provider_name: 'Cap Co',
      marketplace_url: `https://payapi.market/api/d${i}`,
      verified_route_count: 6 - i,
    });
  }
  items.push({
    ...fixture[0],
    id: 'f0',
    name: 'Finance One',
    category: 'Finance',
    provider_name: 'Cap Co',
    marketplace_url: 'https://payapi.market/api/f0',
  });
  const readme = renderReadme(items, { date: DATE, topPicks: [] });
  assert.match(readme, /^- Cap Co: 1 more$/m);
  assert.ok(readme.includes('Finance One'));
  assert.ok(readme.includes('Data 0'));
  assert.ok(!readme.includes('Data 5'));
});

test('"N more" is a plain line and the section intro links to the marketplace', () => {
  const readme = renderReadme(fixture, { date: DATE });
  assert.match(readme, /^- Acme Data: 2 more$/m);
  assert.match(readme, /\[payapi\.market\/marketplace\]\(https:\/\/payapi\.market\/marketplace\)/);
  assert.ok(!readme.includes('Acme Echo'));
  assert.ok(!readme.includes('+2 more'));
});

test('a provider_slug does not turn the overflow line into a link', () => {
  const withSlug = fixture.map((i) => (i.provider_name === 'Acme Data' ? { ...i, provider_slug: 'acme-data-co' } : i));
  const readme = renderReadme(withSlug, { date: DATE });
  assert.match(readme, /^- Acme Data: 2 more$/m);
  assert.ok(!readme.includes('https://payapi.market/provider/acme-data-co'));
});

test('pipes and newlines are escaped in cells', () => {
  const readme = renderReadme(fixture, { date: DATE });
  const row = readme.split('\n').find((l) => l.includes('Parser'));
  assert.match(row, /Pipe \\\| Parser/);
  assert.match(row, /Parses a \\\| b columns\./);
  assert.equal(row.split(/(?<!\\)\|/).length, 7); // 5 cells + 2 outer empties
});

test('square brackets in a description are escaped so they are not reference links', () => {
  const item = {
    ...fixture[0],
    id: 'br',
    name: 'Bracket Note',
    description: 'Returns a numbered [n] citation.',
    marketplace_url: 'https://payapi.market/api/bracket-note',
  };
  const readme = renderReadme([item], { date: DATE, topPicks: [] });
  assert.match(readme, /numbered \\\[n\\\] citation/);
});

test('descriptions trim on a word boundary within 100 chars and use three dots', () => {
  const long = 'word '.repeat(40);
  const out = trimDescription(long);
  assert.ok(out.length <= 100);
  assert.ok(out.endsWith('...'));
  assert.match(out, /^(word )*word\.\.\.$/);
});

test('trimDescription strips em and en dashes', () => {
  assert.equal(trimDescription('Range 0.01\u20130.02 and a pause \u2014 then more.'), 'Range 0.01 to 0.02 and a pause, then more.');
  assert.equal(trimDescription('Already fine.'), 'Already fine.');
  assert.doesNotMatch(trimDescription('A \u2014 B and 1\u20132.'), /[\u2013\u2014]/);
});

test('price formatting uses "to" and an empty cell when the price is missing', () => {
  assert.equal(formatPrice(0.01, 0.01), '0.01');
  assert.equal(formatPrice(0.001, 0.25), '0.001 to 0.25');
  assert.equal(formatPrice(1, 1.5), '1 to 1.5');
  assert.equal(formatPrice(null, null), '');
  assert.doesNotMatch(formatPrice(0.001, 0.25), /[\u2013\u2014$]/);
});

test('chains use advertised or verified networks, falling back to network', () => {
  const readme = renderReadme(fixture, { date: DATE });
  assert.match(readme, /\| Base, Solana \|/);
  assert.ok(!readme.includes('Ethereum'));
  assert.match(readme, /\[Fallback Chain\].*\| Solana \|/);
});

test('output is deterministic, dash-free, and has no provider count', () => {
  const a = renderReadme(fixture, { date: DATE, externalMd: 'x' });
  const b = renderReadme([...fixture].reverse(), { date: DATE, externalMd: 'x' });
  assert.equal(a, b);
  assert.doesNotMatch(a, /[\u2013\u2014\u2026]/);
  assert.match(a, /Range 0\.01 to 0\.02 and a pause, then more\./);
  assert.match(a, /1 to 1\.5/);
  assert.doesNotMatch(a, /Last generated/);
  assert.doesNotMatch(a, /verified APIs/);
  assert.doesNotMatch(a, /\d+ providers/);
  assert.match(a, /^Updated: 2026-10-13\./m);
});

test('API names link to the listing and the receipt stays in its own column', () => {
  const readme = renderReadme(fixture, { date: DATE });
  assert.match(readme, /\[Acme Alpha\]\(https:\/\/payapi\.market\/api\/acme-alpha\)/);
  assert.match(readme, /\[tx\]\(https:\/\/basescan\.org\/tx\/0xa1\)/);
  assert.ok(!readme.includes('https://acmedata.example.com/v1/a1'));
  assert.ok(!readme.includes('✅'));
});

test('intro, top picks, method and footer order', () => {
  const readme = renderReadme(fixture, { date: DATE, externalMd: 'EXTERNAL-BLOCK' });
  assert.match(readme, /The best x402 APIs are pay-per-call APIs/);
  assert.match(readme, /## Top picks/);
  assert.match(readme, /\[LaborPulse\]\(https:\/\/payapi\.market\/api\/laborpulse\)/);
  assert.doesNotMatch(readme, /healthy/i);
  const how = readme.split('## How APIs get on this list')[1].split('## Add your API')[0];
  assert.match(how, /^1\. /m);
  assert.match(how, /^2\. /m);
  assert.doesNotMatch(how, /^3\. /m);
  assert.match(how, /Unclaimed \(bazaar\)/);
  assert.match(
    how,
    /Data report: \[The x402 API market: a snapshot from PayAPI Market, October 2026 \(Zenodo, DOI 10\.5281\/zenodo\.23658608\)\]\(https:\/\/doi\.org\/10\.5281\/zenodo\.23658608\)/,
  );
  assert.match(readme, /you keep 100%/);
  assert.doesNotMatch(readme, /enterprise|paid tier|\bSLA\b/i);
  const order = [
    '## Top picks',
    '## Other x402 APIs',
    'EXTERNAL-BLOCK',
    '## Developer tools and SDKs',
    '## How APIs get on this list',
    '## Add your API',
    '## Licence',
  ];
  const positions = order.map((s) => readme.indexOf(s));
  assert.deepEqual([...positions].sort((x, y) => x - y), positions);
  assert.ok(positions.every((p) => p >= 0));
});

test('rows sharing a marketplace_url keep every row and link the name to /marketplace/<id>', () => {
  const dupA = { ...fixture[0], id: 'dup-a', name: 'Shared One', marketplace_url: 'https://payapi.market/api/shared' };
  const dupB = { ...fixture[0], id: 'dup-b', name: 'Shared Two', marketplace_url: 'https://payapi.market/api/shared' };
  const readme = renderReadme([...fixture, dupA, dupB], { date: DATE });
  const rows = readme.split('\n').filter((l) => l.includes('Shared '));
  assert.equal(rows.length, 2);
  assert.match(rows[0], /\[Shared One\]\(https:\/\/payapi\.market\/marketplace\/dup-a\)/);
  assert.match(rows[1], /\[Shared Two\]\(https:\/\/payapi\.market\/marketplace\/dup-b\)/);
  assert.ok(!readme.includes('https://payapi.market/api/shared)'));
  assert.match(readme, /\[Acme Alpha\]\(https:\/\/payapi\.market\/api\/acme-alpha\)/);
});
