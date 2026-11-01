// Project-level operations used by the CLI (and any other embedder of the engine).
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { generateOffsetsJson, generateSdkHeader, validateAndLayoutState } from '../codegen.mjs';
import { readConfig } from '../config.mjs';
import { applyPatch, emptyState, normalizeState } from './apply.mjs';
import { diffStates } from './diff.mjs';
import { asReverserError, ReverserError } from './errors.mjs';
import { atomicWrite, readOptional } from './fsx.mjs';
import { withLock } from './lock.mjs';
import { projectPaths } from './project.mjs';
import { validatePatch } from './schema.mjs';

export const SCHEMA_VERSION = 1;

function loadConfig(root) {
  try {
    return readConfig(root);
  } catch (error) {
    throw asReverserError(error, 'layout');
  }
}

export async function loadState(paths) {
  const raw = await readOptional(paths.state);
  if (raw === null) return normalizeState(emptyState());
  try {
    return normalizeState(JSON.parse(raw));
  } catch (error) {
    throw new ReverserError('io', `Cannot parse ${paths.state}: ${error.message}`);
  }
}

export const revisionOf = state => (Number.isInteger(state.revision) ? state.revision : 0);

/** Render artifacts in memory. Throws ReverserError(layout) on invalid state. */
export function renderArtifacts(state, config) {
  try {
    validateAndLayoutState(state, config);
    return { sdkHeader: generateSdkHeader(state, config), offsetsJson: generateOffsetsJson(state, config) };
  } catch (error) {
    throw asReverserError(error, 'layout');
  }
}

const serialize = state => JSON.stringify(state, null, 2) + '\n';
const content = state => {
  const { revision, schemaVersion, ...rest } = state;
  return JSON.stringify(rest);
};

async function writeArtifacts(paths, artifacts, signal) {
  await atomicWrite(paths.sdkHeader, artifacts.sdkHeader, signal);
  await atomicWrite(paths.offsetsJson, artifacts.offsetsJson, signal);
}

/**
 * Validate + merge + regenerate under the project lock.
 * @param {string} root
 * @param {unknown} patch
 * @param {{dryRun?: boolean, expectedRevision?: number, signal?: AbortSignal, lockTimeoutMs?: number}} [options]
 */
export async function runUpdate(root, patch, { dryRun = false, expectedRevision, signal, lockTimeoutMs } = {}) {
  const check = validatePatch(patch);
  if (!check.ok) {
    const first = check.errors[0];
    throw new ReverserError('patch', `Invalid patch: ${first.path} ${first.message}${check.errors.length > 1 ? ` (+${check.errors.length - 1} more)` : ''}`, {
      path: first.path,
      errors: check.errors,
    });
  }
  const paths = projectPaths(root, loadConfig(root));

  return withLock(paths.lock, async () => {
    signal?.throwIfAborted();
    const before = await loadState(paths);
    const current = revisionOf(before);
    if (expectedRevision !== undefined && expectedRevision !== current) {
      throw new ReverserError('conflict', `Revision conflict: expected ${expectedRevision}, database is at ${current}. Re-read and rebuild the patch.`);
    }
    let after;
    try {
      after = applyPatch(before, patch);
    } catch (error) {
      throw asReverserError(error, 'patch');
    }
    const artifacts = renderArtifacts(after, paths.config);
    const changed = content(before) !== content(after);
    const diff = diffStates(before, after);
    const files = [paths.state, paths.sdkHeader, paths.offsetsJson].map(f => relative(root, f).replace(/\\/g, '/'));

    if (!changed || dryRun) {
      return { changed, dryRun, revision: current, diff, counts: counts(after), files: [] };
    }

    after.schemaVersion = SCHEMA_VERSION;
    after.revision = current + 1;
    await atomicWrite(paths.state, serialize(after), signal);
    try {
      await writeArtifacts(paths, artifacts);
    } catch (error) {
      throw new ReverserError('io', `Database committed at revision ${after.revision}, but writing artifacts failed (${error.message}). Run "reverser generate".`);
    }
    return { changed: true, dryRun: false, revision: after.revision, diff, counts: counts(after), files };
  }, { timeoutMs: lockTimeoutMs, signal });
}

export function counts(state) {
  return {
    structs: state.structs.length,
    fields: state.structs.reduce((n, s) => n + (s.fields?.length || 0), 0),
    enums: state.enums.length,
    globals: state.globals.length,
    functions: state.functions.length,
  };
}

/** Rewrite artifacts from the database (always writes). */
export async function regenerate(root, { lockTimeoutMs } = {}) {
  const paths = projectPaths(root, loadConfig(root));
  return withLock(paths.lock, async () => {
    const state = await loadState(paths);
    const artifacts = renderArtifacts(state, paths.config);
    await writeArtifacts(paths, artifacts);
    return { revision: revisionOf(state), files: [paths.sdkHeader, paths.offsetsJson].map(f => relative(root, f).replace(/\\/g, '/')) };
  }, { timeoutMs: lockTimeoutMs });
}

/** Artifact freshness = on-disk files equal what the database would generate now. */
export async function status(root) {
  const paths = projectPaths(root, loadConfig(root));
  const state = await loadState(paths);
  const exists = (await readOptional(paths.state)) !== null;
  let artifacts;
  let error;
  try {
    const expected = renderArtifacts(state, paths.config);
    const [h, o] = await Promise.all([readOptional(paths.sdkHeader), readOptional(paths.offsetsJson)]);
    artifacts = h === null || o === null ? 'missing' : h === expected.sdkHeader && o === expected.offsetsJson ? 'fresh' : 'stale';
  } catch (e) {
    artifacts = 'invalid';
    error = e.message;
  }
  const rel = f => relative(root, f).replace(/\\/g, '/');
  return {
    root,
    database: exists ? rel(paths.state) : null,
    schemaVersion: state.schemaVersion ?? SCHEMA_VERSION,
    revision: revisionOf(state),
    counts: counts(state),
    artifacts,
    ...(error ? { error } : {}),
    paths: { sdkHeader: rel(paths.sdkHeader), offsetsJson: rel(paths.offsetsJson), decompiled: rel(paths.decompiled) },
    target: { name: paths.config.target, arch: paths.config.arch, imageBase: paths.config.imageBase },
  };
}

/** Validate database layout without writing. */
export async function validateProject(root) {
  const paths = projectPaths(root, loadConfig(root));
  const state = await loadState(paths);
  renderArtifacts(state, paths.config);
  return { revision: revisionOf(state), counts: counts(state) };
}

/** Create database (never overwrite), decompiled dir and initial artifacts. */
export async function initProject(root, { writeConfig = false } = {}) {
  const paths = projectPaths(root, loadConfig(root));
  await mkdir(paths.decompiled, { recursive: true });
  let createdConfig = false;
  if (writeConfig) {
    const { target, arch, imageBase, sdkHeaderPath, offsetsJsonPath, decompiledDirectory, namespace } = paths.config;
    await mkdir(dirname(paths.configFile), { recursive: true });
    createdConfig = await writeFile(
      paths.configFile,
      JSON.stringify({ target, arch, imageBase, sdkHeaderPath, offsetsJsonPath, decompiledDirectory, namespace }, null, 2) + '\n',
      { flag: 'wx' }
    ).then(() => true, e => { if (e.code !== 'EEXIST') throw e; return false; });
  }
  return withLock(paths.lock, async () => {
    const initial = { schemaVersion: SCHEMA_VERSION, revision: 0, ...emptyState() };
    const created = await writeFile(paths.state, serialize(initial), { flag: 'wx' }).then(
      () => true,
      e => { if (e.code !== 'EEXIST') throw e; return false; }
    );
    if (created) await writeArtifacts(paths, renderArtifacts(initial, paths.config));
    const rel = f => relative(root, f).replace(/\\/g, '/');
    return { created, createdConfig, database: rel(paths.state), config: rel(paths.configFile) };
  });
}
