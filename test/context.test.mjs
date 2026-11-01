import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactContext } from '../src/context.mjs';
const config = { target: 'test', arch: 'x86', imageBase: '0x400000', sdkHeaderPath: 'sdk/SDK.h', offsetsJsonPath: 'sdk/offsets.json', decompiledDirectory: 'decompiled', context: { symbols: ['Chunk'], maxChars: 1500 } };
const state = { structs: [{ name: 'Chunk', size: '0x64', fields: [{ name: 'payload', offset: '0x04', type: 'void*', confidence: 'guessed' }] }], functions: [{ name: 'WriteBits', address: '0x507010', signature: 'void WriteBits()' }] };
test('compact selection preserves uncertainty without generated padding', () => {
 const text = compactContext(state, config, 'WriteBits');
 assert.match(text, /payload \[guessed\]/); assert.match(text, /0x507010/);
 assert.doesNotMatch(text, /static_assert|pad_000/); assert.ok(text.length <= 1500);
});
test('budget omits entire entries and reports omissions', () => {
 const text = compactContext({ structs: [{ name: 'Chunk', comment: 'x'.repeat(10000) }] }, config);
 assert.ok(text.length <= 1500); assert.match(text, /omitted by budget/);
});
