import assert from 'node:assert/strict';
import test from 'node:test';
import { search, show } from '../src/engine/query.mjs';
import { readFixture } from '../test-support/helpers.mjs';

const state = JSON.parse(readFixture('expected/state.json'));

test('search ranks exact name first and reports truncation', () => {
  const r = search(state, 'player');
  assert.equal(r.results[0].name, 'Player');
  const limited = search(state, 'e', { limit: 2 });
  assert.equal(limited.results.length, 2);
  assert.equal(limited.truncated, true);
  assert.deepEqual(search(state, 'tick', { kinds: ['vmethod'] }).results.map(x => x.name), ['Tick']);
});

test('show by name, member, offset and address', () => {
  assert.equal(show(state, 'Player').kind, 'struct');
  assert.equal(show(state, 'Player.position').entry.offset, '0x0020');
  assert.equal(show(state, 'Player.0x20').entry.name, 'position');
  assert.equal(show(state, 'Entity.Spawn').kind, 'vmethod');
  assert.equal(show(state, '0x01566798').entry.name, 'g_LocalPlayer');
});

test('show address miss returns nearest preceding function', () => {
  const r = show(state, '0x401500');
  assert.equal(r.kind, 'vmethod'); // exact vtable method hit wins
  assert.throws(() => show(state, '0x10'), { kind: 'notFound' });
});

test('show ambiguous and not found', () => {
  const s = structuredClone(state);
  s.globals.push({ name: 'Player', address: '0x10', type: 'int' });
  assert.throws(() => show(s, 'Player'), e => e.kind === 'ambiguous' && e.candidates.length === 2);
  assert.throws(() => show(state, 'Plyer'), { kind: 'notFound' });
});
