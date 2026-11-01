// On-disk layout of a reverser project.
//
// New projects keep their data in `.reverser/`. Projects created by the Pi
// extension (pi-reverser) keep it in `.pi/`; they are detected and used in
// place, so the CLI and Pi can work on the same project side by side.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const DATA_DIR = '.reverser';
export const LEGACY_DATA_DIR = '.pi';
export const DATABASE_FILE = 'reverser.json';
export const CONFIG_FILE = 'reverser.config.json';
export const LOCK_FILE = 'reverser.lock';

const markers = [DATABASE_FILE, CONFIG_FILE];
const hasData = (root, dir) => markers.some(m => existsSync(join(root, dir, m)));

/** True when `root` contains a reverser project (either layout). */
export const isProject = root => hasData(root, DATA_DIR) || hasData(root, LEGACY_DATA_DIR);

/** Data directory name for `root`: `.reverser` unless only a legacy `.pi` project exists. */
export const dataDirName = root => (!hasData(root, DATA_DIR) && hasData(root, LEGACY_DATA_DIR) ? LEGACY_DATA_DIR : DATA_DIR);
