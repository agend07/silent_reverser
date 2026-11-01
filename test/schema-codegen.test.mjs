import assert from 'node:assert/strict';
import test from 'node:test';
import { generateOffsetsJson, generateSdkHeader, validateAndLayoutState } from '../src/codegen.mjs';
import { readConfig } from '../src/config.mjs';
import { patchSchema, validatePatch } from '../src/engine/schema.mjs';
import { readFixture, tempProject } from '../test-support/helpers.mjs';

const config = readConfig(tempProject());

test('valid patch passes', () => {
  for (const p of JSON.parse(readFixture('patch-sequence.json'))) assert.deepEqual(validatePatch(p), { ok: true, errors: [] });
});

test('errors carry precise paths', () => {
  const paths = p => validatePatch(p).errors.map(e => e.path);
  assert.deepEqual(paths({ structs: [{ fields: [] }] }), ['structs[0].name']);
  assert.deepEqual(paths({ structs: [{ name: 'A', fields: [{ offset: '0x0', name: 'a', type: 'int', confidence: 'sure' }] }] }), ['structs[0].fields[0].confidence']);
  assert.deepEqual(paths({ structs: [{ name: 'A', fields: [{ offest: '0x0', name: 'a', type: 'int' }] }] }), ['structs[0].fields[0].offset', 'structs[0].fields[0].offest']);
  assert.deepEqual(paths({ functions: [{ name: 'f', address: '0xZZ' }] }), ['functions[0].address']);
  assert.deepEqual(paths({ bogus: [] }), ['bogus']);
  assert.deepEqual(paths([]), ['(root)']);
  assert.deepEqual(paths({ removeVtableMethods: [{ struct: 'A', indices: [1.5] }] }), ['removeVtableMethods[0].indices[0]']);
});

test('schema is plain JSON', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(patchSchema)), patchSchema);
});

test('golden SDK header and offsets', () => {
  const state = JSON.parse(readFixture('expected/state.json'));
  assert.equal(generateSdkHeader(state, config), readFixture('expected/SDK.h'));
  assert.equal(generateOffsetsJson(state, config), readFixture('expected/offsets.json'));
  assert.equal(generateSdkHeader(state, config), generateSdkHeader(structuredClone(state), config));
});

test('layout validation rejects bad states', () => {
  const st = (fields, extra = {}) => ({ structs: [{ name: 'A', fields, ...extra }], enums: [], globals: [], functions: [] });
  const f = (offset, name, type = 'uint32_t') => ({ offset, name, type });
  assert.throws(() => validateAndLayoutState(st([f('0x0', 'a'), f('0x2', 'b')]), config), /overlap/);
  assert.throws(() => validateAndLayoutState(st([f('0x0', 'pad_0000')]), config), /manual padding/);
  assert.throws(() => validateAndLayoutState(st([], { inherits: 'Nope' }), config), /unknown struct/);
  assert.throws(() => validateAndLayoutState(st([f('0x10', 'a')], { size: '0x8' }), config), /smaller/);
  assert.throws(() => validateAndLayoutState(st([f('0x0', 'a', 'Mystery')]), config), /Unknown size/);
});
