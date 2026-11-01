# silent_reverser

A reverse-engineering memory-map database and deterministic C++ SDK generator, driven by a single CLI: **`reverser`**.

It is built for AI coding agents (Claude Code, Codex, Pi, Cursor, Aider, … — anything that can run a shell command) as well as humans. All state lives in one JSON database; every change goes through a validated patch; the C++ header and offsets file are always regenerated from the database, never hand-edited.

- **Single source of truth** — `.reverser/reverser.json`.
- **Deterministic SDK** — `sdk/SDK.h` with byte-accurate `char pad_XXXX[...]` gaps and `static_assert(offsetof/sizeof)`, plus `sdk/offsets.json`.
- **Safe for concurrent agents** — cross-process project lock, atomic writes, revision counter with optimistic concurrency (`--expected-revision`).
- **Machine-friendly** — `--json` emits exactly one JSON object on stdout, stable exit codes, strict patch schema (typos like `offest` are rejected).
- **Zero dependencies** — plain Node.js ≥ 20, no build step, no network, no model.

## Install

```sh
git clone https://github.com/agend07/silent_reverser
cd silent_reverser
npm link            # puts `reverser` on PATH
```

or run it directly: `node <repo>/bin/reverser.mjs <command>`.

## Quick start

```sh
cd my-target
reverser init                                   # .reverser/reverser.json + .reverser/reverser.config.json, sdk/, decompiled/
reverser update --file docs/patch-examples/01-new-struct.json
reverser show Camera.fov
reverser status
reverser preview                                # live, diff-highlighted view in the terminal
```

## Commands

```sh
reverser init                                   # create database + default config (never overwrites)
reverser status [--json]                        # counts, revision, artifacts fresh|stale|missing|invalid
reverser search Camera [--limit 20] [--kind struct,field,vmethod,enum,global,function]
reverser show Camera | Camera.fov | Camera.0x10 | 0x0056F0D0
reverser update --file patch.json [--dry-run] [--expected-revision N]
reverser update --stdin                         # UTF-8, BOM tolerated
reverser validate                               # layout check, no writes
reverser generate                               # rewrite SDK.h + offsets.json from the database
reverser context --symbols Camera,Player [--max-chars 6000]
reverser preview                                # live preview in the current terminal
reverser schema                                 # patch JSON Schema
```

Global options: `--project <dir>` (default: search upwards from the current directory), `--json`, `--lock-timeout <ms>` (default 10000).

`show <address>` returns an exact match (function, global, vtable, vtable method) or, failing that, the nearest preceding function with a `delta`.

### JSON output

With `--json`, stdout carries exactly one object:

```json
{"ok":true,"command":"update","data":{"changed":true,"revision":3,"diff":{...},"files":[...]}}
{"ok":false,"command":"update","error":{"code":2,"kind":"layout","message":"...","path":"structs[0].fields[1].type","symbol":"Camera"}}
```

Without `--json`, human-readable output goes to stdout and diagnostics to stderr (no ANSI colours in either).

### Exit codes

| Exit | Meaning |
|---|---|
| 0 | OK (including "no changes") |
| 1 | Invalid patch (JSON, schema, hex literal, unknown struct in removals) |
| 2 | Layout/validation error (overlap, manual padding, unknown type size, …) |
| 3 | Project lock timeout |
| 4 | I/O error (if after the database commit: run `reverser generate`) |
| 5 | Project or symbol not found |
| 6 | Ambiguous symbol (`show`), candidates listed |
| 7 | `--expected-revision` conflict |
| 64 | CLI usage error |

A non-zero exit means nothing was written — except exit 4 after the database was committed, which `reverser status` reports as stale artifacts and `reverser generate` repairs.

## Using it from an agent

Drop [`AGENTS.md`](AGENTS.md) (Codex, Pi, Cursor, generic) or [`CLAUDE.md`](CLAUDE.md) (Claude Code) into the analysed project, or paste its content into your harness's instructions. The workflow is:

1. **Read before analysing** — `reverser search <text> --json`, then `reverser show <Name|Struct.field|0xADDR> --json`. Missing entries are not evidence of absence.
2. **Write only via patches** — `reverser update --file patch.json --dry-run --json`, then without `--dry-run`. Pass `--expected-revision N` (from `reverser status --json`) when the patch is based on an earlier read; exit 7 means someone else wrote in between — re-read and retry.
3. **Bounded context** — `reverser context --symbols A,B` prints a compact summary (offsets, types, confidence; no generated padding) within a character budget, suitable for pasting into a prompt.

`reverser schema` prints the patch JSON Schema; harnesses that support custom tools can use it directly as the tool's parameter schema and pipe the arguments to `reverser update --stdin --json`.

## Patch format

Patches are incremental: omitted collections and properties are preserved. Examples: [`docs/patch-examples/`](docs/patch-examples/).

- **`structs`** — upsert (`name`, `inherits?`, `size?`, `vtable?`, `comment?`, `fields?`, `vtableMethods?`).
  - Fields are merged by `offset` or `name` (renaming a field at an existing offset, or moving a named field, updates it in place).
  - **Never pass `pad_XXXX` fields** — padding is computed automatically; overlapping fields are rejected with a descriptive error.
  - Field types: `<cstdint>` primitives (`uint8_t` … `int64_t`, `uintptr_t`, `intptr_t`, `size_t`), `bool`, `char`, `float`, `double`, `Vector2/3/4`, `Matrix3x4`, `Matrix4x4`, pointers (`void*`, `Camera*`), fixed arrays (`char[32]`), and known enums/structs.
  - `confidence`: `"confirmed"` (default), `"probable"`, `"guessed"`. Put evidence (instruction address, decompiled file) in `comment`.
  - Setting `inherits` / `size` / `vtable` / `comment` to `""` removes the property.
- **`enums`** — upsert `enum class` definitions (default underlying type `uint32_t`; values merged by name).
- **`globals`** — upsert by name or address: `address`, `type`, `signature` (AOB), `pointerChain`.
- **`functions`** — upsert by address or name: `address`, `name`, `callingConvention`, `signature`, `decompiledFile`, `comment`.
- **Removals** — `removeStructs`, `removeFields` (by name or hex offset), `removeVtableMethods`, `removeEnums`, `removeGlobals`, `removeFunctions`.

## Project configuration (`.reverser/reverser.config.json`)

```json
{
  "target": "Game.exe (1.0.2 retail)",
  "binaryPath": "C:/Games/Game/Game.exe",
  "sha256": "3911fcc8914b0158c434cee36f19295316e715d4c9a0e70c857e8c39e3d54258",
  "arch": "x86",
  "imageBase": "0x00400000",
  "sdkHeaderPath": "sdk/SDK.h",
  "offsetsJsonPath": "sdk/offsets.json",
  "decompiledDirectory": "decompiled",
  "namespace": "Game",
  "context": { "maxChars": 6000 }
}
```

Defaults when omitted: `arch: "x86"` (`"x64"` for 8-byte pointers), `imageBase: "0x00400000"`, `sdkHeaderPath: "sdk/SDK.h"`, `offsetsJsonPath: "sdk/offsets.json"`, `decompiledDirectory: "decompiled"`, `namespace: "SDK"`. `context.maxChars` (1500..12000) is the default character budget of `reverser context`.

## Project layout & consistency

```
my-target/
  .reverser/reverser.json          # database (commit it)
  .reverser/reverser.config.json   # configuration (commit it)
  .reverser/reverser.lock          # transient lock (ignore it)
  sdk/SDK.h, sdk/offsets.json      # generated
  decompiled/                      # your pseudocode exports
```

All writers take the project lock (stale locks from dead processes or older than 5 minutes are taken over). The database carries `schemaVersion` and `revision` (incremented per effective change). Writes are atomic per file in the order database → SDK.h → offsets.json.

**Pi compatibility.** Projects created by the [pi-reverser](https://github.com/agend07/pi-reverser) extension keep their data in `.pi/` instead of `.reverser/`. Such projects are detected and used in place (a `.reverser/` directory takes precedence if both exist), and the generated header keeps the pi-reverser wording, so Pi and the CLI can work on the same project and see each other's artifacts as fresh.

## Live preview

`reverser preview` redraws on every database change:

- green `+` — newly discovered struct, field, vtable slot, enum, global or function,
- yellow `~` — modified type, name, signature or size in the latest update,
- red `−` — items removed in the latest update,
- dim gray `pad_XXXX` — unmapped padding.

Keys: Up/Down (`j`/`k`), PageUp/PageDown/Space, Home/End (`g`/`G`), mouse wheel, `q` or Ctrl+C to quit. Run it in a split pane (tmux, WezTerm, Windows Terminal, …) next to your agent.

## Development

```sh
npm test            # node --test
```

Layout: `bin/reverser.mjs` (CLI), `src/engine/` (validation, merge, lock, store, query), `src/codegen.mjs`, `src/config.mjs`, `src/context.mjs`, `src/preview.mjs`, `test/`.

## License

MIT
