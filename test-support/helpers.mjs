import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
export const fixture = name => join(repo, 'test', 'fixtures', name);
export const readFixture = name => readFileSync(fixture(name), 'utf8');
export const tempProject = () => mkdtempSync(join(tmpdir(), 'reverser test '));
