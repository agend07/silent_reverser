import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPatch, emptyState } from '../src/engine/apply.mjs';
import { readFixture } from '../test-support/helpers.mjs';

const base = () =>
  applyPatch(emptyState(), {
    structs: [
      {
        name: 'Player',
        size: '0x40',
        comment: 'player',
        vtable: '0x134A000',
        fields: [
          { offset: '0x4', name: 'hp', type: 'float', confidence: 'probable', comment: 'mulss' },
          { offset: '0x10', name: 'pos', type: 'Vector3' },
        ],
        vtableMethods: [{ index: 1, name: 'Tick', address: '0x401000' }],
      },
    ],
    enums: [{ name: 'Team', values: [{ name: 'A', value: '0' }] }],
    globals: [{ name: 'g_P', address: '0x1000', type: 'Player*' }],
    functions: [{ name: 'F', address: '0x401000' }],
  });

test('does not mutate input', () => {
  const s = base();
  const copy = structuredClone(s);
  applyPatch(s, { removeStructs: ['Player'] });
  assert.deepEqual(s, copy);
});

test('normalizes hex and defaults', () => {
  const s = base();
  const p = s.structs[0];
  assert.equal(p.size, '0x0040');
  assert.equal(p.vtable, '0x0134A000');
  assert.equal(p.fields[0].offset, '0x0004');
  assert.equal(p.fields[1].confidence, 'confirmed');
  assert.equal(p.vtableMethods[0].address, '0x00401000');
  assert.equal(s.enums[0].underlyingType, 'uint32_t');
  assert.equal(s.globals[0].address, '0x00001000');
});

test('omitted collections and properties are preserved', () => {
  const s = applyPatch(base(), { structs: [{ name: 'Player' }] });
  assert.deepEqual(s, base());
});

test('field matched by offset renames, keeps confidence and comment', () => {
  const f = applyPatch(base(), { structs: [{ name: 'Player', fields: [{ offset: '0x4', name: 'health', type: 'float' }] }] })
    .structs[0].fields[0];
  assert.deepEqual(f, { offset: '0x0004', name: 'health', type: 'float', confidence: 'probable', comment: 'mulss' });
});

test('field matched by name moves and retypes', () => {
  const fields = applyPatch(base(), { structs: [{ name: 'Player', fields: [{ offset: '0x20', name: 'hp', type: 'int32_t' }] }] })
    .structs[0].fields;
  assert.deepEqual(fields.map(f => [f.offset, f.name, f.type]), [['0x0010', 'pos', 'Vector3'], ['0x0020', 'hp', 'int32_t']]);
});

test('empty string removes struct properties', () => {
  const p = applyPatch(base(), { structs: [{ name: 'Player', size: '', vtable: '', comment: '', inherits: '' }] }).structs[0];
  assert.equal(p.size, undefined);
  assert.equal(p.vtable, undefined);
  assert.equal(p.comment, undefined);
});

test('vtable methods matched by index and sorted', () => {
  const vm = applyPatch(base(), {
    structs: [{ name: 'Player', vtableMethods: [{ index: 1, name: 'Update' }, { index: 0, name: 'Dtor' }] }],
  }).structs[0].vtableMethods;
  assert.deepEqual(vm.map(m => [m.index, m.name, m.address]), [[0, 'Dtor', undefined], [1, 'Update', '0x00401000']]);
});

test('removals by name and hex', () => {
  const s = applyPatch(base(), {
    removeFields: [{ struct: 'Player', fields: ['0x10'] }],
    removeVtableMethods: [{ struct: 'Player', indices: [1] }],
    removeFunctions: ['0x401000'],
    removeGlobals: ['g_P'],
    removeEnums: ['Team'],
  });
  assert.deepEqual(s.structs[0].fields.map(f => f.name), ['hp']);
  assert.deepEqual(s.structs[0].vtableMethods, []);
  assert.deepEqual([s.functions, s.globals, s.enums], [[], [], []]);
  assert.deepEqual(applyPatch(base(), { removeFields: [{ struct: 'Player', fields: ['hp'] }] }).structs[0].fields.map(f => f.name), ['pos']);
  assert.deepEqual(applyPatch(base(), { removeFunctions: ['F'] }).functions, []);
  assert.deepEqual(applyPatch(base(), { removeStructs: ['Player'] }).structs, []);
});

test('removeFields on unknown struct throws', () => {
  assert.throws(() => applyPatch(base(), { removeFields: [{ struct: 'Nope', fields: ['x'] }] }), /Unknown struct/);
  assert.throws(() => applyPatch(base(), { removeVtableMethods: [{ struct: 'Nope', indices: [0] }] }), /Unknown struct/);
});

test('globals/functions matched by name or address, sorted by address', () => {
  let s = applyPatch(base(), { globals: [{ name: 'g_Player', address: '0x1000', type: 'Player*' }, { name: 'g_A', address: '0x10', type: 'int32_t' }] });
  assert.deepEqual(s.globals.map(g => g.name), ['g_A', 'g_Player']);
  s = applyPatch(base(), { functions: [{ name: 'F', address: '0x402000' }, { name: 'G', address: '0x400000', confidence: 'guessed' }] });
  assert.deepEqual(s.functions.map(f => [f.name, f.address, f.confidence]), [['G', '0x00400000', 'guessed'], ['F', '0x00402000', 'confirmed']]);
});

test('enum values merged by name', () => {
  const e = applyPatch(base(), { enums: [{ name: 'Team', underlyingType: 'uint8_t', values: [{ name: 'A', value: '5' }, { name: 'B', value: '6' }] }] }).enums[0];
  assert.equal(e.underlyingType, 'uint8_t');
  assert.deepEqual(e.values.map(v => [v.name, v.value]), [['A', '5'], ['B', '6']]);
});

test('patch sequence reproduces golden state (verified against original index.ts)', () => {
  let s = emptyState();
  for (const p of JSON.parse(readFixture('patch-sequence.json'))) {
    try {
      s = applyPatch(s, p);
    } catch {}
  }
  const expected = JSON.parse(readFixture('expected/state.json'));
  delete expected.revision;
  delete expected.schemaVersion;
  assert.deepEqual(s, expected);
});
