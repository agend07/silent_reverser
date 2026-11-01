// Pure patch merge. Semantics copied 1:1 from the original index.ts reverser_update.
import { formatHex, parseHex } from '../config.mjs';
import { ReverserError } from './errors.mjs';

export const emptyState = () => ({ structs: [], enums: [], globals: [], functions: [] });

const isHex = s => /^0x[0-9a-fA-F]+$/.test(s.trim());

export function normalizeState(state) {
  const s = state && typeof state === 'object' ? state : emptyState();
  s.structs ||= [];
  s.enums ||= [];
  s.globals ||= [];
  s.functions ||= [];
  return s;
}

/** Returns a new state; input is not mutated. Throws ReverserError(kind 'patch') on unknown struct references. */
export function applyPatch(input, patch) {
  const state = normalizeState(structuredClone(input));

  // 1. Enums
  if (patch.removeEnums?.length) {
    state.enums = state.enums.filter(e => !patch.removeEnums.includes(e.name));
  }
  for (const change of patch.enums || []) {
    const existing = state.enums.find(e => e.name === change.name);
    if (!existing) {
      state.enums.push({
        name: change.name,
        underlyingType: change.underlyingType || 'uint32_t',
        ...(change.comment ? { comment: change.comment } : {}),
        values: change.values || [],
      });
    } else {
      if (change.underlyingType) existing.underlyingType = change.underlyingType;
      if (change.comment !== undefined) existing.comment = change.comment;
      existing.values ||= [];
      for (const val of change.values || []) {
        const idx = existing.values.findIndex(v => v.name === val.name);
        if (idx < 0) existing.values.push(val);
        else existing.values[idx] = val;
      }
    }
  }

  // 2. Structs
  if (patch.removeStructs?.length) {
    state.structs = state.structs.filter(s => !patch.removeStructs.includes(s.name));
  }
  for (const rm of patch.removeFields || []) {
    const st = state.structs.find(s => s.name === rm.struct);
    if (!st) throw new ReverserError('patch', `Unknown struct in removeFields: ${rm.struct}`, { symbol: rm.struct });
    const targets = new Set(rm.fields);
    const hexTargets = new Set(rm.fields.filter(isHex).map(f => parseHex(f)));
    st.fields = (st.fields || []).filter(f => !targets.has(f.name) && !hexTargets.has(parseHex(f.offset)));
  }
  for (const rm of patch.removeVtableMethods || []) {
    const st = state.structs.find(s => s.name === rm.struct);
    if (!st) throw new ReverserError('patch', `Unknown struct in removeVtableMethods: ${rm.struct}`, { symbol: rm.struct });
    st.vtableMethods = (st.vtableMethods || []).filter(m => !rm.indices.includes(m.index));
  }
  for (const change of patch.structs || []) {
    let st = state.structs.find(s => s.name === change.name);
    if (!st) {
      st = { name: change.name, fields: [], vtableMethods: [] };
      state.structs.push(st);
    }
    st.fields ||= [];
    if (change.inherits !== undefined) {
      if (change.inherits === '') delete st.inherits;
      else st.inherits = change.inherits;
    }
    if (change.size !== undefined) {
      if (change.size === '') delete st.size;
      else st.size = formatHex(parseHex(change.size), 4);
    }
    if (change.vtable !== undefined) {
      if (change.vtable === '') delete st.vtable;
      else st.vtable = formatHex(parseHex(change.vtable), 8);
    }
    if (change.comment !== undefined) {
      if (change.comment === '') delete st.comment;
      else st.comment = change.comment;
    }
    for (const field of change.fields || []) {
      const normOffset = formatHex(parseHex(field.offset), 4);
      // Match by same offset OR same name so renaming or moving a field works.
      // NOTE: if offset matches one field and name matches another, the first in array order wins
      // and the other remains -> may yield a duplicate-name/overlap error at validation.
      const existingIdx = st.fields.findIndex(
        f => parseHex(f.offset) === parseHex(normOffset) || f.name === field.name
      );
      const prev = existingIdx >= 0 ? st.fields[existingIdx] : {};
      const normalizedField = {
        ...prev,
        ...field,
        offset: normOffset,
        confidence: field.confidence || prev.confidence || 'confirmed',
      };
      if (existingIdx < 0) st.fields.push(normalizedField);
      else st.fields[existingIdx] = normalizedField;
    }
    st.fields.sort((a, b) => parseHex(a.offset) - parseHex(b.offset));

    for (const vm of change.vtableMethods || []) {
      const existingIdx = (st.vtableMethods ||= []).findIndex(m => m.index === vm.index);
      const prev = existingIdx >= 0 ? st.vtableMethods[existingIdx] : {};
      const normVm = {
        ...prev,
        ...vm,
        ...(vm.address ? { address: formatHex(parseHex(vm.address), 8) } : {}),
      };
      if (existingIdx < 0) st.vtableMethods.push(normVm);
      else st.vtableMethods[existingIdx] = normVm;
    }
    (st.vtableMethods ||= []).sort((a, b) => a.index - b.index);
  }

  // 3. Globals
  if (patch.removeGlobals?.length) {
    state.globals = state.globals.filter(g => !patch.removeGlobals.includes(g.name));
  }
  for (const g of patch.globals || []) {
    const normAddr = formatHex(parseHex(g.address), 8);
    const idx = state.globals.findIndex(
      item => item.name === g.name || parseHex(item.address) === parseHex(normAddr)
    );
    const prev = idx >= 0 ? state.globals[idx] : {};
    const normG = { ...prev, ...g, address: normAddr };
    if (idx < 0) state.globals.push(normG);
    else state.globals[idx] = normG;
  }
  state.globals.sort((a, b) => parseHex(a.address) - parseHex(b.address));

  // 4. Functions
  if (patch.removeFunctions?.length) {
    const rmSet = new Set(patch.removeFunctions);
    const rmAddrs = new Set(patch.removeFunctions.filter(isHex).map(x => parseHex(x)));
    state.functions = state.functions.filter(fn => !rmSet.has(fn.name) && !rmAddrs.has(parseHex(fn.address)));
  }
  for (const fn of patch.functions || []) {
    const normAddr = formatHex(parseHex(fn.address), 8);
    const idx = state.functions.findIndex(
      item => parseHex(item.address) === parseHex(normAddr) || item.name === fn.name
    );
    const prev = idx >= 0 ? state.functions[idx] : {};
    const normFn = {
      ...prev,
      ...fn,
      address: normAddr,
      confidence: fn.confidence || prev.confidence || 'confirmed',
    };
    if (idx < 0) state.functions.push(normFn);
    else state.functions[idx] = normFn;
  }
  state.functions.sort((a, b) => parseHex(a.address) - parseHex(b.address));

  return state;
}
