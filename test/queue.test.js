import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QueueManager } from '../src/managers/QueueManager.js';

const track = (title) => ({ encoded: `enc-${title}`, title });

test('add/next advances in order', () => {
  const q = new QueueManager();
  q.add(track('a'));
  q.add(track('b'));
  assert.equal(q.size, 2);
  assert.equal(q.next().title, 'a');
  assert.equal(q.next().title, 'b');
  assert.equal(q.next(), null);
  assert.equal(q.isEmpty, true);
});

test('loop=track replays current', () => {
  const q = new QueueManager();
  q.add(track('a'));
  q.add(track('b'));
  q.next();
  q.setLoop('track');
  assert.equal(q.replayCurrent().title, 'a');
  assert.equal(q.size, 2);
});

test('loop=queue rotates current to the end', () => {
  const q = new QueueManager();
  q.add(track('a'));
  q.add(track('b'));
  q.add(track('c'));
  q.next(); // current a
  q.setLoop('queue');
  assert.equal(q.rotate().title, 'b');
  assert.deepEqual(q.all().map((t) => t.title), ['b', 'c', 'a']);
});

test('removeAt uses 1-based positions and protects now-playing', () => {
  const q = new QueueManager();
  q.add(track('a'));
  q.add(track('b'));
  q.add(track('c'));
  q.next();
  assert.equal(q.removeAt(1), null);
  assert.equal(q.removeAt(2).title, 'b');
  assert.equal(q.removeAt(99), undefined);
  assert.deepEqual(q.all().map((t) => t.title), ['a', 'c']);
});

test('shuffle keeps current and all tracks', () => {
  const q = new QueueManager();
  for (const t of ['a', 'b', 'c', 'd', 'e']) q.add(track(t));
  q.next();
  q.shuffle();
  assert.equal(q.size, 5);
  assert.equal(q.current.title, 'a');
  assert.deepEqual([...q.tracks.map((t) => t.title)].sort(), ['b', 'c', 'd', 'e']);
});

test('setLoop rejects invalid modes', () => {
  const q = new QueueManager();
  assert.throws(() => q.setLoop('bogus'), /Loop mode/);
});
