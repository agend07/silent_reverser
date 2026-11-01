# Reverse-engineering state: `reverser`

Reverse-engineering state lives in `.reverser/reverser.json` (or `.pi/reverser.json` in older projects) and is managed by the `reverser` CLI (`node <silent_reverser>/bin/reverser.mjs` if not on PATH). `sdk/SDK.h` and `sdk/offsets.json` are generated — never edit them by hand.

- Before analysis: `reverser search <text> --json`, then `reverser show <Name|Struct.field|0xADDR> --json`. Missing entries are not evidence of absence.
- Record discoveries only as patches: write `patch.json`, run `reverser update --file patch.json --dry-run --json`, then without `--dry-run`. Use `--expected-revision N` (from `reverser status --json`) when your patch is based on an earlier read; exit 7 = someone else wrote meanwhile, re-read and retry.
- Patch format: `reverser schema`. Only specify discovered fields with hex offsets and strict types; padding is automatic, never pass `pad_XXXX`.
- Preserve `confidence` (`confirmed` / `probable` / `guessed`) and put evidence (instruction address, decompiled file) in `comment`.
- Non-zero exit = nothing was written (except exit 4 after commit: run `reverser generate`). Fix the reported `path`/`symbol` and retry.
- Compact summary of selected symbols for your context: `reverser context --symbols A,B`.
