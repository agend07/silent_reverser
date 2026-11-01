import test from 'node:test';
import assert from 'node:assert/strict';
import { minimapRows, minimapOffset } from '../src/minimap.mjs';

test('maps offscreen changes and viewport independently', () => {
  const lines = Array(100).fill('unchanged');
  lines[80] = '\x1b[42;30m+ added';
  const rows = minimapRows(lines, 0, 10);
  assert.equal(rows.length, 10);
  assert.match(rows[8], /\x1b\[32m/);
  assert.doesNotMatch(rows[8], /\x1b\[36m/);
  assert.match(rows[0], /\x1b\[36m/);
});

test('removals take priority when changes share a bucket', () => {
  const rows = minimapRows(['\x1b[42;30m+', '\x1b[43;30m~', '\x1b[41;37m−'], 0, 1);
  assert.match(rows[0], /\x1b\[31m/);
});

test('empty and short documents fill the map safely', () => {
  assert.equal(minimapRows([], 0, 24).length, 24);
  assert.equal(minimapRows(['line'], 0, 24).length, 24);
  assert.equal(minimapOffset(24, 24, 1), 0);
});

test('click mapping clamps at document bounds', () => {
  assert.equal(minimapOffset(1, 10, 100), 0);
  assert.equal(minimapOffset(6, 10, 100), 50);
  assert.equal(minimapOffset(10, 10, 100), 90);
});
