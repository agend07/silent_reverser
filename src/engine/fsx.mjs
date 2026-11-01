import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** rename with retry for transient Windows locks (antivirus, open viewers). */
export async function renameRetry(from, to, delays = [50, 100, 200, 400, 800]) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(from, to);
    } catch (error) {
      if (!RETRYABLE.has(error.code) || attempt >= delays.length) throw error;
      await sleep(delays[attempt]);
    }
  }
}

export async function atomicWrite(filePath, content, signal) {
  await mkdir(dirname(filePath), { recursive: true });
  const temp = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, content, 'utf8');
    signal?.throwIfAborted();
    await renameRetry(temp, filePath);
  } finally {
    await unlink(temp).catch(() => {});
  }
}

export const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

export async function readOptional(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export const stripBom = text => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
