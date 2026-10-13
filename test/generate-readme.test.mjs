import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  fetchAllListings,
  cleanListings,
  applyProviderCap,
  renderReadme,
  providerSlug,
  formatPrice,
  trimDescription,
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

test('cap keeps 5 per provider by routes, then reliability, then name', () => {
  const { kept, more } = applyProviderCap(cleanListings(fixture));
  const acme = kept.filter((i) => i.provider_name === 'Acme Data').map((i) => i.name);
  assert.deepEqual(acme, ['Acme Alpha', 'Acme Golf', 'Acme Bravo', 'Acme Charlie', 'Acme Delta']);
  assert.deepEqual(more, [{ provider: 'Acme Data', count: 2 }]);
});

test('"+N more" links to a provider search', () => {
  const readme = renderReadme(fixture, { date: DATE });
  assert.match(
    readme,
    /- Acme Data: \[\+2 more on payapi\.market\]\(https:\/\/payapi\.market\/provider\/acme-data\)/,
  );
  assert.ok(!readme.includes('Acme Echo'));
});

test('house APIs carry the (house) tag, others do not', () => {
  const readme = renderReadme(fixture, { date: DATE });
  assert.match(readme, /\[House Oracle \(house\)\]/);
  assert.ok(!/Acme Alpha \(house\)/.test(readme));
});

test('pipes and newlines are escaped in cells', () => {
  const readme = renderReadme(fixture, { date: DATE });
  const row = readme.split('\n').find((l) => l.includes('Parser'));
  assert.match(row, /Pipe \\\| Parser/);
  assert.match(row, /Parses a \\\| b columns\./);
  assert.equal(row.split(/(?<!\\)\|/).length, 8); // 6 cells + 2 outer empties
});

test('descriptions trim on a word boundary within 100 chars', () => {
  const long = 'word '.repeat(40);
  const out = trimDescription(long);
  assert.ok(out.length <= 100);
  assert.ok(out.endsWith('…'));
  assert.match(out, /^(word )*word…$/);
});

test('price formatting', () => {
  assert.equal(formatPrice(0.01, 0.01), '$0.01');
  assert.equal(formatPrice(0.001, 0.25), '$0.001–0.25');
  assert.equal(formatPrice(1, 1.5), '$1–1.5');
  assert.equal(formatPrice(null, null), '—');
});

test('chains use advertised or verified networks, falling back to network', () => {
  const readme = renderReadme(fixture, { date: DATE });
  assert.match(readme, /\| Base, Solana \|/);
  assert.ok(!readme.includes('Ethereum'));
  assert.match(readme, /\[Fallback Chain\].*\| Solana \|/);
});

test('output is deterministic and byte-identical for the same input', () => {
  const a = renderReadme(fixture, { date: DATE, externalMd: 'x' });
  const b = renderReadme([...fixture].reverse(), { date: DATE, externalMd: 'x' });
  assert.equal(a, b);
});

test('header counts, disclosure and footer order', () => {
  const readme = renderReadme(fixture, { date: DATE, externalMd: 'EXTERNAL-BLOCK' });
  assert.match(readme, /Last generated: 2026-10-13 \(UTC\) · 10 verified APIs from 4 providers/);
  assert.match(readme, /Maintained by PayAPI Market\./);
  const order = ['## Other x402 APIs', 'EXTERNAL-BLOCK', '## Developer tools and SDKs', '## Contributing'];
  const positions = order.map((s) => readme.indexOf(s));
  assert.deepEqual([...positions].sort((x, y) => x - y), positions);
  assert.ok(positions.every((p) => p >= 0));
});

test('provider slug lowercases and collapses non-alphanumerics', () => {
  assert.equal(providerSlug('Acme Data'), 'acme-data');
  assert.equal(providerSlug('  PayAPI -- Market!! '), 'payapi-market');
});

test('rows sharing a marketplace_url keep every row and link to /marketplace/<id>', () => {
  const dupA = { ...fixture[7], id: 'dup-a', name: 'Shared One', marketplace_url: 'https://payapi.market/api/shared' };
  const dupB = { ...fixture[7], id: 'dup-b', name: 'Shared Two', marketplace_url: 'https://payapi.market/api/shared' };
  const readme = renderReadme([...fixture, dupA, dupB], { date: DATE });
  const rows = readme.split('\n').filter((l) => l.includes('Shared '));
  assert.equal(rows.length, 2);
  assert.match(rows[0], /\[payapi\]\(https:\/\/payapi\.market\/marketplace\/dup-a\)/);
  assert.match(rows[1], /\[payapi\]\(https:\/\/payapi\.market\/marketplace\/dup-b\)/);
  assert.ok(!readme.includes('https://payapi.market/api/shared)'));
  // unshared rows keep their own marketplace_url
  assert.match(readme, /\(https:\/\/payapi\.market\/api\/house-oracle\)/);
});
