// Cross-process project lock: `<data dir>/reverser.lock` created with O_EXCL.
import { open, readFile, unlink, mkdir, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { ReverserError } from './errors.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
export const STALE_MS = 5 * 60_000;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function isStale(lockPath) {
  let info;
  try {
    info = JSON.parse(await readFile(lockPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return false; // released meanwhile, just retry
    // Empty/corrupt: either just created by another process (not yet written) or crashed mid-write.
    try {
      return Date.now() - (await stat(lockPath)).mtimeMs > 2000;
    } catch {
      return false;
    }
  }
  if (Date.now() - Date.parse(info.startedAt) > STALE_MS) return true;
  return info.host === hostname() && Number.isInteger(info.pid) && !alive(info.pid);
}

/**
 * Runs fn while holding the lock.
 * @template T
 * @param {string} lockPath
 * @param {() => Promise<T>} fn
 * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
 * @returns {Promise<T>}
 */
export async function withLock(lockPath, fn, { timeoutMs = 10_000, signal } = {}) {
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let handle;
  for (;;) {
    signal?.throwIfAborted();
    try {
      handle = await open(lockPath, 'wx');
      break;
    } catch (error) {
      if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
    }
    if (await isStale(lockPath)) {
      await unlink(lockPath).catch(() => {});
      continue;
    }
    if (Date.now() >= deadline) {
      throw new ReverserError('lock', `Timed out after ${timeoutMs} ms waiting for project lock ${lockPath}`);
    }
    await sleep(50 + Math.random() * 100);
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }));
  } finally {
    await handle.close();
  }
  try {
    return await fn();
  } finally {
    await unlink(lockPath).catch(() => {});
  }
}
