import { dirname, join, resolve } from 'node:path';
import { readConfig } from '../config.mjs';
import { CONFIG_FILE, DATABASE_FILE, LOCK_FILE, dataDirName, isProject } from '../layout.mjs';
import { ReverserError } from './errors.mjs';

/** Explicit dir wins; otherwise walk up from start looking for .reverser/ (or legacy .pi/) project data. */
export function findProject(start = process.cwd(), explicit) {
  if (explicit) return resolve(explicit);
  let dir = resolve(start);
  for (;;) {
    if (isProject(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new ReverserError('notFound', `No reverser project found from ${resolve(start)} upwards (expected .reverser/${DATABASE_FILE}). Run "reverser init" or pass --project.`);
    }
    dir = parent;
  }
}

export function projectPaths(root, config = readConfig(root)) {
  const data = join(root, dataDirName(root));
  return {
    root,
    config,
    dataDir: data,
    state: join(data, DATABASE_FILE),
    configFile: join(data, CONFIG_FILE),
    lock: join(data, LOCK_FILE),
    manifest: join(data, 'reverser.artifacts.json'),
    sdkHeader: join(root, config.sdkHeaderPath),
    offsetsJson: join(root, config.offsetsJsonPath),
    decompiled: join(root, config.decompiledDirectory),
  };
}
