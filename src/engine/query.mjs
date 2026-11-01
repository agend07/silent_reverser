import { formatHex, parseHex } from '../config.mjs';
import { ReverserError } from './errors.mjs';

const asNumber = q => {
  if (typeof q !== 'string' || !/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(q.trim())) return null;
  return parseHex(q.trim());
};

/** Flatten state into searchable entries. */
function* entries(state) {
  for (const s of state.structs || []) {
    yield { kind: 'struct', name: s.name, ...(s.size ? { size: s.size } : {}), ...(s.vtable ? { address: s.vtable } : {}), comment: s.comment };
    for (const f of s.fields || []) {
      yield { kind: 'field', name: f.name, parent: s.name, offset: f.offset, type: f.type, confidence: f.confidence, comment: f.comment };
    }
    for (const m of s.vtableMethods || []) {
      yield { kind: 'vmethod', name: m.name, parent: s.name, index: m.index, address: m.address, comment: m.comment };
    }
  }
  for (const e of state.enums || []) yield { kind: 'enum', name: e.name, comment: e.comment };
  for (const g of state.globals || []) yield { kind: 'global', name: g.name, address: g.address, type: g.type, comment: g.comment };
  for (const f of state.functions || []) {
    yield { kind: 'function', name: f.name, address: f.address, signature: f.signature, confidence: f.confidence, comment: f.comment };
  }
}

const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));

/**
 * Case-insensitive substring search over names, comments, types, signatures and hex addresses.
 * Name matches rank first. Field offsets match only when qualified as "Struct.0x10" (too noisy otherwise).
 */
export function search(state, query, { limit = 20, kinds } = {}) {
  const q = String(query).trim().toLowerCase();
  if (!q) throw new ReverserError('usage', 'Empty search query.');
  const num = asNumber(q);
  const hits = [];
  for (const e of entries(state)) {
    if (kinds && !kinds.includes(e.kind)) continue;
    let score = -1;
    const name = e.name.toLowerCase();
    const full = e.parent ? `${e.parent}.${e.name}`.toLowerCase() : name;
    if (name === q || full === q) score = 0;
    else if (num !== null && e.address && e.kind !== 'field' && parseHex(e.address) === num) score = 0;
    else if (name.startsWith(q)) score = 1;
    else if (full.includes(q)) score = 2;
    else if (e.address && e.address.toLowerCase().includes(q.replace(/^0x/, ''))) score = 3;
    else if ([e.type, e.signature, e.comment].some(t => t && t.toLowerCase().includes(q))) score = 4;
    if (score >= 0) hits.push({ score, e });
  }
  hits.sort((a, b) => a.score - b.score || a.e.name.localeCompare(b.e.name));
  const results = hits.slice(0, limit).map(({ e }) => {
    const { comment, ...rest } = e;
    return clean({ ...rest, comment: comment && comment.length > 120 ? comment.slice(0, 117) + '...' : comment });
  });
  return { query, results, total: hits.length, truncated: hits.length > results.length };
}

/**
 * Exact lookup by name, "Struct.field", "Struct.0xOFFSET" or address.
 * Throws notFound / ambiguous; address misses return the nearest preceding function.
 */
export function show(state, key) {
  const k = String(key).trim();
  if (!k) throw new ReverserError('usage', 'Empty symbol.');
  const dot = k.indexOf('.');
  if (dot > 0) {
    const structName = k.slice(0, dot);
    const member = k.slice(dot + 1);
    const st = (state.structs || []).find(s => s.name === structName);
    if (!st) throw new ReverserError('notFound', `Unknown struct "${structName}"`, { symbol: structName });
    const off = asNumber(member);
    const field = (st.fields || []).find(f => f.name === member || (off !== null && parseHex(f.offset) === off));
    if (field) return { kind: 'field', parent: st.name, entry: field };
    const vm = (st.vtableMethods || []).find(m => m.name === member);
    if (vm) return { kind: 'vmethod', parent: st.name, entry: vm };
    throw new ReverserError('notFound', `No member "${member}" in struct "${structName}"`, { symbol: k });
  }

  const num = asNumber(k);
  const matches = [];
  if (num !== null) {
    for (const f of state.functions || []) if (parseHex(f.address) === num) matches.push({ kind: 'function', entry: f });
    for (const g of state.globals || []) if (parseHex(g.address) === num) matches.push({ kind: 'global', entry: g });
    for (const s of state.structs || []) {
      if (s.vtable && parseHex(s.vtable) === num) matches.push({ kind: 'struct', entry: s, match: 'vtable' });
      for (const m of s.vtableMethods || []) {
        if (m.address && parseHex(m.address) === num) matches.push({ kind: 'vmethod', parent: s.name, entry: m });
      }
    }
  } else {
    for (const [kind, list] of [['struct', state.structs], ['enum', state.enums], ['global', state.globals], ['function', state.functions]]) {
      for (const x of list || []) if (x.name === k) matches.push({ kind, entry: x });
    }
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new ReverserError('ambiguous', `"${k}" matches ${matches.length} entries; qualify the query.`, {
      symbol: k,
      candidates: matches.map(m => clean({ kind: m.kind, name: m.entry.name, parent: m.parent, address: m.entry.address })),
    });
  }
  if (num !== null) {
    const preceding = (state.functions || [])
      .filter(f => parseHex(f.address) <= num)
      .sort((a, b) => parseHex(b.address) - parseHex(a.address))[0];
    if (preceding) {
      return { kind: 'function', match: 'nearest', delta: formatHex(num - parseHex(preceding.address), 1), entry: preceding };
    }
  }
  const suggestions = search(state, k, { limit: 5 }).results.map(r => (r.parent ? `${r.parent}.${r.name}` : r.name));
  throw new ReverserError('notFound', `No entry "${k}"${suggestions.length ? `; similar: ${suggestions.join(', ')}` : ''}`, { symbol: k });
}
