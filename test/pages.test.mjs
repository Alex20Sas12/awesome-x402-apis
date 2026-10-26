import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = readFileSync(new URL('../_config.yml', import.meta.url), 'utf8');
const robots = readFileSync(new URL('../robots.txt', import.meta.url), 'utf8');

test('Jekyll config serves the repo root in British English', () => {
  assert.match(config, /^title: Awesome x402 APIs$/m);
  assert.match(config, /^description: ""$/m);
  assert.match(config, /^lang: en-GB$/m);
  assert.match(config, /^theme: jekyll-theme-minimal$/m);
  assert.match(config, /jekyll-seo-tag/);
  assert.match(config, /jekyll-sitemap/);
  assert.match(config, /^url: https:\/\/payapi-market\.github\.io$/m);
  assert.match(config, /^baseurl: \/awesome-x402-apis$/m);
  for (const item of ['node_modules', 'scripts', 'test', 'package.json', 'CONTRIBUTING.md', 'data']) {
    assert.match(config, new RegExp(`^\\s*- ${item.replace('.', '\\.')}$`, 'm'));
  }
});

test('home page title matches the site title so the document title is not doubled', () => {
  const home = config.slice(config.indexOf('path: README.md'));
  assert.match(home, /title: Awesome x402 APIs/);
  assert.match(
    home,
    /description: Settlement-verified x402 APIs that AI agents can pay per call in USDC on Base, Solana or Algorand\. Curated from PayAPI Market\./,
  );
  assert.match(config, /^description: ""$/m);
});

test('robots.txt sitemap URL is the Pages sitemap', () => {
  const url = config.match(/^url: (.+)$/m)[1];
  const base = config.match(/^baseurl: (.+)$/m)[1];
  assert.equal(`${url}${base}/sitemap.xml`, 'https://payapi-market.github.io/awesome-x402-apis/sitemap.xml');
  assert.match(robots, /Sitemap: \{\{ site\.url \}\}\{\{ site\.baseurl \}\}\/sitemap\.xml/);
  assert.match(robots, /^User-agent: \*$/m);
  assert.match(robots, /^Allow: \/$/m);
});
