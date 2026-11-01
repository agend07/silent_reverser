import { parseHex } from '../config.mjs';

const keyOf = {
  structs: s => s.name,
  enums: e => e.name,
  globals: g => g.name,
  functions: f => f.name,
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function fieldDiff(before = [], after = []) {
  const key = f => `${parseHex(f.offset)}`;
  const b = new Map(before.map(f => [key(f), f]));
  const a = new Map(after.map(f => [key(f), f]));
  const out = { added: [], changed: [], removed: [] };
  for (const [k, f] of a) {
    if (!b.has(k)) out.added.push(`${f.offset} ${f.name}`);
    else if (!same(b.get(k), f)) out.changed.push(`${f.offset} ${f.name}`);
  }
  for (const [k, f] of b) if (!a.has(k)) out.removed.push(`${f.offset} ${f.name}`);
  return out;
}

/** Summary of entry-level changes between two states (names only; struct entries carry field detail). */
export function diffStates(before, after) {
  const result = {};
  for (const kind of Object.keys(keyOf)) {
    const b = new Map((before[kind] || []).map(x => [keyOf[kind](x), x]));
    const a = new Map((after[kind] || []).map(x => [keyOf[kind](x), x]));
    const d = { added: [], changed: [], removed: [] };
    for (const [k, x] of a) {
      if (!b.has(k)) d.added.push(k);
      else if (!same(b.get(k), x)) {
        if (kind === 'structs') {
          const fields = fieldDiff(b.get(k).fields, x.fields);
          d.changed.push({ name: k, fields });
        } else d.changed.push(k);
      }
    }
    for (const k of b.keys()) if (!a.has(k)) d.removed.push(k);
    if (d.added.length || d.changed.length || d.removed.length) result[kind] = d;
  }
  return result;
}
