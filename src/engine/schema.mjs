// Patch schema (JSON Schema subset) + dependency-free validator.
// Same object is used by the patch validator and `reverser schema` (usable as tool parameters by agent harnesses).
import { callingConventions, confidenceLevels, parseHex } from '../config.mjs';

const str = description => (description ? { type: 'string', description } : { type: 'string' });
const num = description => (description ? { type: 'number', description } : { type: 'number' });
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const arr = (items, description) => (description ? { type: 'array', items, description } : { type: 'array', items });

const confidence = {
  type: 'string',
  enum: [...confidenceLevels],
  description: 'Evidence level: confirmed (verified in code), probable (strong inference), guessed (hypothesis). Default: confirmed.',
};

const field = obj(
  {
    offset: str('Hex offset inside struct, e.g. "0x0140"'),
    name: str('C++ field identifier (never pass pad_XXXX; padding is automatic)'),
    type: str('Strict C++ type: <cstdint> (uint32_t, float, ...), pointer (Foo*, void*), array (uint8_t[16]), or known struct/enum'),
    size: num('Explicit byte size override (only needed for custom opaque types)'),
    confidence,
    comment: str('Evidence / instruction reference, e.g. "read in mulss at 0x0056f102"'),
  },
  ['offset', 'name', 'type']
);

const vtableMethod = obj(
  {
    index: num('Zero-based vtable slot index (offset = index * ptrSize)'),
    name: str('Method name, e.g. "UpdateCamera"'),
    address: str('Hex address of implementation if known, e.g. "0x0056F0D0"'),
    signature: str('C++ signature, e.g. "void(__thiscall*)( void* thisPtr, float dt )"'),
    comment: str(),
  },
  ['index', 'name']
);

const struct = obj(
  {
    name: str('Struct/Class identifier, e.g. "DemoPlayer"'),
    inherits: str('Optional base struct name ("" removes)'),
    size: str('Optional total known struct size in hex, e.g. "0x2000" ("" removes)'),
    vtable: str('Optional vtable address in hex, e.g. "0x0134A000" ("" removes)'),
    comment: str(),
    fields: arr(field, 'Fields to add/update (matched by offset or name). Omitted fields are preserved.'),
    vtableMethods: arr(vtableMethod, 'Vtable methods to add/update (matched by index).'),
  },
  ['name']
);

const enumPatch = obj(
  {
    name: str(),
    underlyingType: str('Default: uint32_t'),
    comment: str(),
    values: arr(
      obj({ name: str(), value: str('Hex or integer literal, e.g. "0x0" or "1"'), comment: str() }, ['name', 'value'])
    ),
  },
  ['name', 'values']
);

const globalPatch = obj(
  {
    name: str('Identifier, e.g. "g_ClientGameContext"'),
    address: str('Hex address, e.g. "0x01566798"'),
    type: str('C++ type at address, e.g. "ClientGameContext*"'),
    signature: str('Optional AOB pattern, e.g. "8B 0D ? ? ? ? 85 C9"'),
    pointerChain: arr(str(), 'Optional dereference path, e.g. ["+0x38 ClientPlayerManager*", "+0xAC LocalPlayer*"]'),
    comment: str(),
  },
  ['name', 'address', 'type']
);

const functionPatch = obj(
  {
    address: str('Function entry hex address, e.g. "0x0056F0D0"'),
    name: str('Function identifier, e.g. "DemoPlayer_Tick"'),
    callingConvention: { type: 'string', enum: [...callingConventions] },
    signature: str('Full prototype, e.g. "void __thiscall DemoPlayer_Tick(DemoPlayer* this, float dt)"'),
    decompiledFile: str('Relative path under decompiledDirectory, e.g. "decompiled/DemoPlayer_Tick.c"'),
    confidence,
    comment: str(),
  },
  ['address', 'name']
);

export const patchSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Reverser patch',
  ...obj({
    structs: arr(struct),
    removeStructs: arr(str()),
    removeFields: arr(
      obj({ struct: str(), fields: arr(str('Field name or hex offset (e.g. "0x0140") to remove')) }, ['struct', 'fields'])
    ),
    removeVtableMethods: arr(obj({ struct: str(), indices: arr(num()) }, ['struct', 'indices'])),
    enums: arr(enumPatch),
    removeEnums: arr(str()),
    globals: arr(globalPatch),
    removeGlobals: arr(str()),
    functions: arr(functionPatch),
    removeFunctions: arr(str('Function name or hex address to remove')),
  }),
};

/** Schema without $schema/title (for tool-parameter consumers). */
export function toolParameters() {
  const { $schema, title, ...rest } = patchSchema;
  return rest;
}

const typeOf = v => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

function check(schema, value, path, errors) {
  const actual = typeOf(value);
  if (schema.type && schema.type !== actual) {
    errors.push({ path: path || '(root)', message: `expected ${schema.type}, got ${actual}` });
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push({ path, message: `must be one of: ${schema.enum.join(', ')}` });
  }
  if (schema.type === 'number' && !Number.isFinite(value)) {
    errors.push({ path, message: 'must be a finite number' });
  }
  if (schema.type === 'object') {
    for (const key of schema.required || []) {
      if (value[key] === undefined) errors.push({ path: join(path, key), message: 'is required' });
    }
    for (const [key, v] of Object.entries(value)) {
      const sub = schema.properties?.[key];
      if (!sub) {
        if (schema.additionalProperties === false) errors.push({ path: join(path, key), message: 'unknown property' });
        continue;
      }
      if (v === undefined) continue;
      check(sub, v, join(path, key), errors);
    }
  }
  if (schema.type === 'array' && schema.items) {
    value.forEach((item, i) => check(schema.items, item, `${path}[${i}]`, errors));
  }
}

const join = (path, key) => (path ? `${path}.${key}` : key);

const hexKeys = { offset: true, address: true, vtable: true, size: true };

function checkHex(value, path, errors) {
  if (Array.isArray(value)) return value.forEach((v, i) => checkHex(v, `${path}[${i}]`, errors));
  if (!value || typeof value !== 'object') return;
  for (const [key, v] of Object.entries(value)) {
    const p = join(path, key);
    if (hexKeys[key] && typeof v === 'string' && v !== '') {
      try {
        parseHex(v);
      } catch {
        errors.push({ path: p, message: `invalid hex/numeric literal "${v}"` });
      }
    } else checkHex(v, p, errors);
  }
}

/** @returns {{ok: boolean, errors: {path: string, message: string}[]}} */
export function validatePatch(patch) {
  const errors = [];
  check(patchSchema, patch, '', errors);
  if (!errors.length) {
    checkHex(patch, '', errors);
    for (const [i, rm] of (patch.removeVtableMethods || []).entries()) {
      rm.indices.forEach((n, j) => {
        if (!Number.isInteger(n) || n < 0) errors.push({ path: `removeVtableMethods[${i}].indices[${j}]`, message: 'must be a non-negative integer' });
      });
    }
    for (const [i, st] of (patch.structs || []).entries()) {
      (st.vtableMethods || []).forEach((vm, j) => {
        if (!Number.isInteger(vm.index) || vm.index < 0) errors.push({ path: `structs[${i}].vtableMethods[${j}].index`, message: 'must be a non-negative integer' });
      });
    }
  }
  return { ok: errors.length === 0, errors };
}
