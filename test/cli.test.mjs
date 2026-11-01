import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { repo, tempProject } from '../test-support/helpers.mjs';

const cliPath = join(repo, 'bin', 'reverser.mjs');

function cli(cwd, args, input) {
  const r = spawnSync(process.execPath, [cliPath, ...args], { cwd, input, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function json(cwd, args, input) {
  const r = cli(cwd, [...args, '--json'], input);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1, `single JSON line expected, got: ${r.stdout}`);
  return { code: r.code, out: JSON.parse(lines[0]), stderr: r.stderr };
}

test('agent workflow end-to-end (path with spaces)', () => {
  const root = tempProject();
  assert.equal(json(root, ['init']).out.data.created, true);

  const patch = { structs: [{ name: 'Camera', size: '0x20', fields: [{ offset: '0x4', name: 'fov', type: 'float', comment: 'evidence' }] }] };
  writeFileSync(join(root, 'patch file.json'), JSON.stringify(patch));

  const dry = json(root, ['update', '--file', 'patch file.json', '--dry-run']);
  assert.equal(dry.code, 0);
  assert.equal(dry.out.data.dryRun, true);
  assert.equal(json(root, ['status']).out.data.revision, 0);

  const up = json(root, ['update', '--file', 'patch file.json']);
  assert.equal(up.out.data.revision, 1);

  // stdin with BOM, from a subdirectory (project discovery upwards)
  const sub = join(root, 'deep', 'dir');
  mkdirSync(sub, { recursive: true });
  const stdinPatch = '\uFEFF' + JSON.stringify({ functions: [{ name: 'Camera_Tick', address: '0x401000' }] });
  assert.equal(json(sub, ['update', '--stdin'], stdinPatch).out.data.revision, 2);

  const st = json(root, ['status']).out.data;
  assert.equal(st.artifacts, 'fresh');
  assert.deepEqual(st.counts, { structs: 1, fields: 1, enums: 0, globals: 0, functions: 1 });

  assert.equal(json(root, ['search', 'cam']).out.data.results[0].name, 'Camera');
  assert.equal(json(root, ['show', 'Camera.fov']).out.data.entry.comment, 'evidence');
  assert.equal(json(root, ['show', '0x401004']).out.data.match, 'nearest');
  assert.match(json(root, ['context', '--symbols', 'Camera']).out.data.text, /0x0004 float fov/);
  assert.equal(json(root, ['validate']).code, 0);
  assert.equal(json(root, ['schema']).out.data.type, 'object');

  writeFileSync(join(root, 'sdk', 'SDK.h'), 'x');
  assert.equal(json(root, ['status']).out.data.artifacts, 'stale');
  assert.equal(json(root, ['generate']).code, 0);
  assert.equal(json(root, ['status']).out.data.artifacts, 'fresh');
});

test('error exit codes and stdout/stderr discipline', () => {
  const root = tempProject();
  cli(root, ['init']);
  const db = () => readFileSync(join(root, '.reverser', 'reverser.json'), 'utf8');
  const before = db();

  const bad = json(root, ['update', '--stdin'], '{"structs":[{"name":"A","fields":[{"offset":"0x0","name":"a"}]}]}');
  assert.equal(bad.code, 1);
  assert.equal(bad.out.error.path, 'structs[0].fields[0].type');

  assert.equal(json(root, ['update', '--stdin'], 'not json').code, 1);
  assert.equal(json(root, ['update', '--stdin'], '{"structs":[{"name":"A","fields":[{"offset":"0x0","name":"pad_0000","type":"int32_t"}]}]}').code, 2);
  assert.equal(json(root, ['update', '--stdin', '--expected-revision', '5'], '{"removeStructs":["X"]}').code, 7);
  assert.equal(db(), before);

  assert.equal(json(root, ['show', 'Nope']).code, 5);
  assert.equal(json(root, ['frobnicate']).code, 64);
  assert.equal(json(root, ['update']).code, 64);
  assert.equal(json(root, ['--bogus-flag']).code, 64);
  assert.equal(json(tempProject(), ['status']).code, 5);

  const human = cli(root, ['show', 'Nope']);
  assert.equal(human.code, 5);
  assert.equal(human.stdout, '');
  assert.match(human.stderr, /No entry "Nope"/);
});

test('ambiguous show exits 6 with candidates', () => {
  const root = tempProject();
  cli(root, ['init']);
  cli(root, ['update', '--stdin'], JSON.stringify({ structs: [{ name: 'Foo' }], globals: [{ name: 'Foo', address: '0x10', type: 'int32_t' }] }));
  const r = json(root, ['show', 'Foo']);
  assert.equal(r.code, 6);
  assert.equal(r.out.error.candidates.length, 2);
});

test('legacy .pi/ project (created by pi-reverser) is used in place', () => {
  const root = tempProject();
  mkdirSync(join(root, '.pi'));
  writeFileSync(join(root, '.pi', 'reverser.json'), JSON.stringify({ structs: [], enums: [], globals: [], functions: [] }));
  const sub = join(root, 'src');
  mkdirSync(sub);
  const up = json(sub, ['update', '--stdin'], JSON.stringify({ structs: [{ name: 'Camera', size: '0x8' }] }));
  assert.equal(up.code, 0);
  assert.ok(up.out.data.files.includes('.pi/reverser.json'));
  assert.equal(existsSync(join(root, '.reverser')), false);
  assert.match(readFileSync(join(root, 'sdk', 'SDK.h'), 'utf8'), /^#pragma once\n\/\/ Auto-generated by pi-reverser \(Single Source of Truth: \.pi\/reverser\.json\)/);
  assert.equal(json(root, ['init']).out.data.created, false);
  assert.equal(existsSync(join(root, '.reverser')), false);
  assert.equal(json(root, ['status']).out.data.artifacts, 'fresh');
});
