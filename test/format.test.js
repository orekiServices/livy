import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, parseDuration, progressBar } from '../src/utils/format.js';

test('formatDuration', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(65_000), '1:05');
  assert.equal(formatDuration(3_661_000), '1:01:01');
  assert.equal(formatDuration(null), 'LIVE');
});

test('parseDuration colon form', () => {
  assert.equal(parseDuration('1:30'), 90_000);
  assert.equal(parseDuration('1:02:03'), 3_723_000);
  assert.equal(parseDuration('bogus'), null);
});

test('parseDuration unit form', () => {
  assert.equal(parseDuration('90s'), 90_000);
  assert.equal(parseDuration('2m'), 120_000);
  assert.equal(parseDuration('1h30m'), 5_400_000);
  assert.equal(parseDuration('45'), null);
});

test('progressBar bounds', () => {
  assert.match(progressBar(0, 100_000), /🔘/);
  assert.match(progressBar(50_000, 100_000), /🔘/);
  assert.equal(progressBar(0, 0), '🔴 LIVE');
});
