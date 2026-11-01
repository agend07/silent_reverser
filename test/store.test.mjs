import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { initProject, regenerate, runUpdate, status, withLock } from '../src/engine/index.mjs';
import { repo, tempProject } from '../test-support/helpers.mjs';

const patchA = { structs: [{ name: 'A', size: '0x10', fields: [{ offset: '0x4', name: 'x', type: 'int32_t' }] }] };

async function project() {
  const root = tempProject();
  await initProject(root);
  return root;
}

const snapshot = root =>
  ['.reverser/reverser.json', 'sdk/SDK.h', 'sdk/offsets.json'].map(f => {
    const p = join(root, f);
    return [readFileSync(p, 'utf8'), statSync(p).mtimeMs];
  });

test('init is idempotent and creates fresh artifacts', async () => {
  const root = await project();
  assert.equal((await initProject(root)).created, false);
  const s = await status(root);
  assert.equal(s.artifacts, 'fresh');
  assert.equal(s.revision, 0);
});

test('update increments revision; no-op does not write', async () => {
  const root = await project();
  const r1 = await runUpdate(root, patchA);
  assert.equal(r1.revision, 1);
  assert.deepEqual(r1.diff.structs.added, ['A']);
  const before = snapshot(root);
  const r2 = await runUpdate(root, patchA);
  assert.equal(r2.changed, false);
  assert.deepEqual(snapshot(root), before);
});

test('invalid patch, layout error and dry-run leave files untouched', async () => {
  const root = await project();
  await runUpdate(root, patchA);
  const before = snapshot(root);
  await assert.rejects(runUpdate(root, { structs: [{ name: 1 }] }), { kind: 'patch', code: 1 });
  await assert.rejects(runUpdate(root, { structs: [{ name: 'A', fields: [{ offset: '0x6', name: 'y', type: 'int32_t' }] }] }), { kind: 'layout', code: 2 });
  await assert.rejects(runUpdate(root, { removeFields: [{ struct: 'Nope', fields: ['x'] }] }), { kind: 'patch' });
  const dry = await runUpdate(root, { structs: [{ name: 'A', fields: [{ offset: '0x8', name: 'y', type: 'int32_t' }] }] }, { dryRun: true });
  assert.equal(dry.changed, true);
  assert.deepEqual(dry.diff.structs.changed[0].fields.added, ['0x0008 y']);
  assert.deepEqual(snapshot(root), before);
  assert.equal(existsSync(join(root, '.reverser', 'reverser.lock')), false);
});

test('expected revision conflict', async () => {
  const root = await project();
  await runUpdate(root, patchA, { expectedRevision: 0 });
  await assert.rejects(runUpdate(root, { removeStructs: ['A'] }, { expectedRevision: 0 }), { kind: 'conflict', code: 7 });
});

test('stale artifacts detected and repaired by regenerate', async () => {
  const root = await project();
  await runUpdate(root, patchA);
  writeFileSync(join(root, 'sdk', 'SDK.h'), '// edited by hand\n');
  assert.equal((await status(root)).artifacts, 'stale');
  await regenerate(root);
  assert.equal((await status(root)).artifacts, 'fresh');
});

test('stale lock from dead process is taken over; live lock times out', async () => {
  const root = await project();
  const lock = join(root, '.reverser', 'reverser.lock');
  writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, host: hostname(), startedAt: new Date().toISOString() }));
  assert.equal((await runUpdate(root, patchA)).revision, 1);
  writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }));
  await assert.rejects(runUpdate(root, { removeStructs: ['A'] }, { lockTimeoutMs: 300 }), { kind: 'lock', code: 3 });
});

test('lock serializes callers in-process', async () => {
  const lock = join(tempProject(), 'l.lock');
  let inside = 0;
  let max = 0;
  await Promise.all(
    Array.from({ length: 5 }, () =>
      withLock(lock, async () => {
        max = Math.max(max, ++inside);
        await new Promise(r => setTimeout(r, 20));
        inside--;
      })
    )
  );
  assert.equal(max, 1);
});

test('parallel updates from separate processes lose nothing', { timeout: 120_000 }, async () => {
  const root = await project();
  const worker = join(repo, 'test-support', 'worker.mjs');
  const run = tag =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [worker, root, tag, '15'], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', d => (err += d));
      child.on('exit', code => (code === 0 ? resolve() : reject(new Error(err))));
    });
  await Promise.all([run('a'), run('b')]);
  const s = await status(root);
  assert.equal(s.counts.fields, 30);
  assert.equal(s.revision, 30);
  assert.equal(s.artifacts, 'fresh');
});
