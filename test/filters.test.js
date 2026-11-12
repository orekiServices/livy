import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FILTER_NAMES, resolveFilter } from '../src/managers/FilterManager.js';
import { parseLyricsResponse } from '../src/managers/LyricsManager.js';
import { parseNodes } from '../src/config.js';

test('filter presets resolve case-insensitively', () => {
  assert.deepEqual(resolveFilter('off'), {});
  assert.ok(resolveFilter('BassBoost').equalizer);
  assert.equal(resolveFilter('nightcore').timescale.speed, 1.25);
  assert.equal(resolveFilter('does-not-exist'), null);
  assert.ok(FILTER_NAMES.includes('off'));
});

test('lyrics parsing handles common NodeLink shapes', () => {
  assert.deepEqual(parseLyricsResponse({ data: { lyrics: 'la la' } }), { lyrics: 'la la', synced: false });
  assert.deepEqual(parseLyricsResponse({ lyrics: 'hey' }), { lyrics: 'hey', synced: false });
  assert.equal(parseLyricsResponse({ data: { lines: [{ line: 'a' }, { line: 'b' }] } }).lyrics, 'a\nb');
  assert.equal(parseLyricsResponse(null), null);
  assert.equal(parseLyricsResponse({ data: {} }), null);
});

test('parseNodes parses the multi-node format', () => {
  const nodes = parseNodes('main,127.0.0.1,3000,youshallnotpass,false;backup,10.0.0.2,3000,pw,true');
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].hostname, '127.0.0.1');
  assert.equal(nodes[0].port, 3000);
  assert.equal(nodes[1].secure, true);
  assert.equal(parseNodes(''), null);
  assert.throws(() => parseNodes('broken'), /Invalid NODELINK_NODES/);
});
