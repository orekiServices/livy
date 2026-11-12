import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIdentifier, isUrl, hasSearchPrefix } from '../src/utils/search.js';

test('URLs pass through untouched', () => {
  assert.equal(buildIdentifier('https://www.youtube.com/watch?v=x'), 'https://www.youtube.com/watch?v=x');
  assert.equal(isUrl('http://example.com/a.mp3'), true);
});

test('known prefixes pass through untouched', () => {
  assert.equal(buildIdentifier('scsearch:lofi'), 'scsearch:lofi');
  assert.equal(buildIdentifier('spsearch:daft punk'), 'spsearch:daft punk');
  assert.equal(hasSearchPrefix('dzsearch:daft punk'), true);
});

test('plain queries get the default source prefix', () => {
  assert.equal(buildIdentifier('never gonna give you up'), 'ytsearch:never gonna give you up');
  assert.equal(buildIdentifier('lofi', 'scsearch:'), 'scsearch:lofi');
});

test('empty query stays empty', () => {
  assert.equal(buildIdentifier('   '), '');
});
