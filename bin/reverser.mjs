#!/usr/bin/env node
// reverser — standalone CLI over the engine. No agent harness, no model, no network.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { compactContext } from '../src/context.mjs';
import {
  EXIT,
  ReverserError,
  findProject,
  initProject,
  loadState,
  patchSchema,
  projectPaths,
  regenerate,
  runUpdate,
  search,
  show,
  status,
  validateProject,
} from '../src/engine/index.mjs';
import { stripBom } from '../src/engine/fsx.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const version = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version ?? '0.0.0';

const HELP = `reverser ${version} — reverse-engineering memory map database & SDK generator

Usage: reverser <command> [options]

Commands:
  init                         Create .reverser/reverser.json (+ default config) if missing
  status                       Counts, revision, artifact freshness
  search <query>               Find entries (--limit N, --kind struct,field,vmethod,enum,global,function)
  show <name|Struct.member|addr>  Full entry; ambiguous -> exit 6
  update --file <p> | --stdin  Apply patch (--dry-run, --expected-revision N)
  validate                     Validate database layout (no writes)
  generate                     Rewrite SDK header and offsets JSON from the database
  context --symbols A,B        Bounded summary for agents (--max-chars N, default 6000)
  preview                      Live terminal preview (Ctrl+C to quit)
  schema                       Print patch JSON Schema

Global options:
  --project <dir>   Project root (default: search upwards for .reverser/ or legacy .pi/)
  --json            Machine-readable single JSON object on stdout
  --lock-timeout <ms>  Wait for project lock (default 10000)
  -h, --help        Show help     -v, --version

Exit codes: 0 ok, 1 invalid patch, 2 layout/validation, 3 lock timeout, 4 io,
            5 not found, 6 ambiguous, 7 revision conflict, 64 usage.`;

const options = {
  project: { type: 'string' },
  json: { type: 'boolean' },
  'lock-timeout': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  file: { type: 'string', short: 'f' },
  stdin: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  'expected-revision': { type: 'string' },
  limit: { type: 'string' },
  kind: { type: 'string' },
  symbols: { type: 'string' },
  'max-chars': { type: 'string' },
};

const usage = msg => new ReverserError('usage', msg);

function int(value, name, min = 0) {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || Number(value) < min) throw usage(`--${name} must be an integer >= ${min}`);
  return Number(value);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(text, source) {
  try {
    return JSON.parse(stripBom(text));
  } catch (error) {
    throw new ReverserError('patch', `Patch from ${source} is not valid JSON: ${error.message}`);
  }
}

// ---- human output -----------------------------------------------------------

const human = {
  init: d => (d.created ? `Initialized ${d.database}` : `Database already exists: ${d.database}`) + (d.createdConfig ? ` (+ ${d.config})` : ''),
  status: d =>
    [
      `Project:   ${d.root}`,
      `Target:    ${d.target.name} (${d.target.arch}, base ${d.target.imageBase})`,
      `Database:  ${d.database ?? '(missing — run reverser init)'}  revision ${d.revision}`,
      `Entries:   ${d.counts.structs} structs (${d.counts.fields} fields), ${d.counts.enums} enums, ${d.counts.globals} globals, ${d.counts.functions} functions`,
      `Artifacts: ${d.artifacts}${d.artifacts === 'stale' || d.artifacts === 'missing' ? ' — run "reverser generate"' : ''}${d.error ? ` — ${d.error}` : ''}`,
      `           ${d.paths.sdkHeader}, ${d.paths.offsetsJson}`,
    ].join('\n'),
  search: d =>
    d.results.length
      ? d.results
          .map(r => {
            const where = r.parent ? `${r.parent}.${r.name}` : r.name;
            const loc = r.offset ?? r.address ?? (r.index !== undefined ? `[${r.index}]` : '');
            return `${r.kind.padEnd(8)} ${where}${loc ? `  ${loc}` : ''}${r.type ? `  ${r.type}` : ''}${r.signature ? `  ${r.signature}` : ''}`;
          })
          .join('\n') + (d.truncated ? `\n... ${d.total - d.results.length} more (use --limit)` : '')
      : `No matches for "${d.query}".`,
  show: d => `${d.kind}${d.parent ? ` in ${d.parent}` : ''}${d.match === 'nearest' ? ` (nearest preceding, +${d.delta})` : ''}\n${JSON.stringify(d.entry, null, 2)}`,
  update: d => {
    const c = d.counts;
    const head = !d.changed
      ? 'No changes — nothing written.'
      : d.dryRun
        ? `Dry run OK — would write revision ${d.revision + 1}.`
        : `Updated to revision ${d.revision}: wrote ${d.files.join(', ')}.`;
    const diff = Object.entries(d.diff)
      .map(([kind, x]) => {
        const changed = x.changed.map(e => (typeof e === 'string' ? e : `${e.name}${fmtFields(e.fields)}`));
        return `  ${kind}: ${[x.added.length && `+${x.added.join(', +')}`, changed.length && `~${changed.join(', ~')}`, x.removed.length && `-${x.removed.join(', -')}`].filter(Boolean).join('  ')}`;
      })
      .join('\n');
    return `${head}\n${diff ? diff + '\n' : ''}Totals: ${c.structs} structs (${c.fields} fields), ${c.enums} enums, ${c.globals} globals, ${c.functions} functions.`;
  },
  validate: d => `OK — revision ${d.revision}, ${d.counts.structs} structs, ${d.counts.functions} functions.`,
  generate: d => `Regenerated from revision ${d.revision}: ${d.files.join(', ')}`,
  context: d => d.text,
  schema: d => JSON.stringify(d, null, 2),
};

function fmtFields(f) {
  const parts = [...f.added.map(x => `+${x}`), ...f.changed.map(x => `~${x}`), ...f.removed.map(x => `-${x}`)];
  return parts.length ? ` [${parts.join('; ')}]` : '';
}

// ---- commands -------------------------------------------------------------------

async function run(command, args, values) {
  const lockTimeoutMs = int(values['lock-timeout'], 'lock-timeout');
  const root = () => findProject(process.cwd(), values.project);

  switch (command) {
    case 'init':
      return initProject(values.project ? resolve(values.project) : process.cwd(), { writeConfig: true });
    case 'status':
      return status(root());
    case 'search': {
      if (!args.length) throw usage('search requires a query');
      const kinds = values.kind?.split(',').map(s => s.trim()).filter(Boolean);
      const r = root();
      return search(await loadState(projectPaths(r)), args.join(' '), { limit: int(values.limit, 'limit', 1) ?? 20, kinds });
    }
    case 'show': {
      if (args.length !== 1) throw usage('show requires exactly one symbol or address');
      return show(await loadState(projectPaths(root())), args[0]);
    }
    case 'update': {
      if (!!values.file === !!values.stdin) throw usage('update requires exactly one of --file <path> or --stdin');
      const text = values.stdin ? await readStdin() : await readFile(resolve(values.file), 'utf8').catch(e => {
        throw new ReverserError('io', `Cannot read patch file: ${e.message}`);
      });
      const patch = parseJson(text, values.stdin ? 'stdin' : values.file);
      return runUpdate(root(), patch, {
        dryRun: !!values['dry-run'],
        expectedRevision: int(values['expected-revision'], 'expected-revision'),
        lockTimeoutMs,
      });
    }
    case 'validate':
      return validateProject(root());
    case 'generate':
      return regenerate(root(), { lockTimeoutMs });
    case 'context': {
      const r = root();
      const paths = projectPaths(r);
      const symbols = (values.symbols ?? args.join(','))
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      const maxChars = int(values['max-chars'], 'max-chars', 1) ?? paths.config.context?.maxChars ?? 6000;
      const config = { ...paths.config, context: { ...paths.config.context, symbols, maxChars } };
      const text = compactContext(await loadState(paths), config, symbols.join(' '));
      return { symbols, maxChars: Math.max(1500, Math.min(12000, maxChars)), text };
    }
    case 'schema':
      return patchSchema;
    case 'preview': {
      const paths = projectPaths(root());
      const child = spawn(process.execPath, [join(here, '..', 'src', 'preview.mjs'), paths.state], { stdio: 'inherit' });
      const code = await new Promise(r => child.on('exit', c => r(c ?? 0)));
      process.exit(code);
    }
    default:
      throw usage(`Unknown command "${command}". Run "reverser --help".`);
  }
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (error) {
    return fail(usage(error.message), argv.includes('--json'), argv[0] ?? null);
  }
  const { values, positionals } = parsed;
  if (values.version) return void process.stdout.write(`${version}\n`);
  const [command, ...args] = positionals;
  if (values.help || !command) {
    process.stdout.write(HELP + '\n');
    return void (process.exitCode = command || values.help ? 0 : EXIT.usage);
  }
  if (command === 'preview' && values.json) return fail(usage('preview does not support --json'), true, command);
  try {
    const data = await run(command, args, values);
    if (values.json) process.stdout.write(JSON.stringify({ ok: true, command, data }) + '\n');
    else process.stdout.write((human[command]?.(data) ?? JSON.stringify(data, null, 2)) + '\n');
  } catch (error) {
    fail(error, values.json, command);
  }
}

function fail(error, json, command) {
  const err = error instanceof ReverserError ? error : new ReverserError('io', error?.message ?? String(error));
  if (json) process.stdout.write(JSON.stringify({ ok: false, command, error: err.toJSON() }) + '\n');
  else {
    process.stderr.write(`reverser: ${err.message}\n`);
    for (const e of err.errors?.slice(1, 20) ?? []) process.stderr.write(`  ${e.path}: ${e.message}\n`);
    for (const c of err.candidates ?? []) process.stderr.write(`  candidate: ${c.kind} ${c.parent ? c.parent + '.' : ''}${c.name}${c.address ? ' ' + c.address : ''}\n`);
  }
  process.exitCode = err.code;
}

await main(process.argv.slice(2));
