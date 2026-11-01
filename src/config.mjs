import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_FILE, DATABASE_FILE, dataDirName } from './layout.mjs';

export const architectures = ['x86', 'x64'];
export const callingConventions = ['__thiscall', '__cdecl', '__stdcall', '__fastcall', '__vectorcall', 'custom'];
export const confidenceLevels = ['confirmed', 'probable', 'guessed'];

export const validRelativePath = value =>
  typeof value === 'string' &&
  value.length > 0 &&
  !value.startsWith('/') &&
  !value.includes('\\') &&
  !value.split('/').some(part => !part || part === '..' || part === '.');

export const validIdentifier = value =>
  typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);

export function parseHex(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value !== 'string') throw new Error(`Invalid hex value: ${value}`);
  const trimmed = value.trim();
  if (/^0x[0-9a-fA-F]+$/.test(trimmed)) return Number.parseInt(trimmed, 16);
  if (/^[0-9]+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  throw new Error(`Invalid hex/numeric literal: ${value} (use e.g. "0x0140")`);
}

export function formatHex(num, minDigits = 4) {
  const n = typeof num === 'number' ? num : parseHex(num);
  return '0x' + n.toString(16).toUpperCase().padStart(minDigits, '0');
}

export function pointerSize(arch) {
  return arch === 'x64' ? 8 : 4;
}

export const baseTypeSizes = {
  bool: 1,
  char: 1,
  int8_t: 1,
  uint8_t: 1,
  int16_t: 2,
  uint16_t: 2,
  int32_t: 4,
  uint32_t: 4,
  int64_t: 8,
  uint64_t: 8,
  float: 4,
  double: 8,
  Vector2: 8,
  Vector3: 12,
  Vector4: 16,
  Matrix3x4: 48,
  Matrix4x4: 64,
};

/**
 * Resolves the byte size and C++ declaration of a field type.
 * Supports:
 * - Primitives & built-in math types (uint32_t, float, Vector3, ...)
 * - Pointer types (void*, SomeStruct*, float**, uintptr_t, intptr_t, size_t)
 * - Fixed-size arrays (char[32], uint32_t[4], void*[8], Vector3[2])
 * - Known structs/enums from state (by value) if size is known or explicit size is provided
 */
export function resolveFieldType(typeStr, arch, knownStructs = new Map(), knownEnums = new Map(), explicitSize = undefined) {
  if (typeof typeStr !== 'string' || !typeStr.trim()) {
    throw new Error('Field type must be a non-empty string.');
  }
  const clean = typeStr.trim();

  // Check array syntax: BaseType[Count]
  const arrayMatch = clean.match(/^(.+?)\s*\[\s*(0x[0-9a-fA-F]+|\d+)\s*\]$/);
  if (arrayMatch) {
    const elemType = arrayMatch[1].trim();
    const count = parseHex(arrayMatch[2]);
    if (count <= 0) throw new Error(`Array count must be > 0 in type "${clean}".`);
    const elem = resolveScalarType(elemType, arch, knownStructs, knownEnums);
    return {
      baseType: elem.baseType,
      arrayCount: count,
      size: explicitSize ?? elem.size * count,
      formatDecl: name => `${elem.baseType} ${name}[${count}]`,
    };
  }

  const scalar = resolveScalarType(clean, arch, knownStructs, knownEnums, explicitSize);
  return {
    baseType: scalar.baseType,
    arrayCount: null,
    size: scalar.size,
    formatDecl: name => `${scalar.baseType} ${name}`,
  };
}

function resolveScalarType(clean, arch, knownStructs, knownEnums, explicitSize) {
  const ptrBytes = pointerSize(arch);
  if (clean.endsWith('*')) {
    return { baseType: clean, size: explicitSize ?? ptrBytes };
  }
  if (clean === 'uintptr_t' || clean === 'intptr_t' || clean === 'size_t') {
    return { baseType: clean, size: explicitSize ?? ptrBytes };
  }
  if (Object.hasOwn(baseTypeSizes, clean)) {
    return { baseType: clean, size: explicitSize ?? baseTypeSizes[clean] };
  }
  if (knownEnums.has(clean)) {
    const enumDef = knownEnums.get(clean);
    const underlying = enumDef?.underlyingType || 'uint32_t';
    const size = baseTypeSizes[underlying] || 4;
    return { baseType: clean, size: explicitSize ?? size };
  }
  if (knownStructs.has(clean)) {
    const structSize = knownStructs.get(clean);
    if (explicitSize !== undefined) return { baseType: clean, size: explicitSize };
    if (structSize !== undefined && structSize > 0) return { baseType: clean, size: structSize };
    throw new Error(`Struct "${clean}" used by value has unknown size; specify explicit "size" on the field or use a pointer "${clean}*".`);
  }
  if (explicitSize !== undefined && explicitSize > 0) {
    return { baseType: clean, size: explicitSize };
  }
  throw new Error(
    `Unknown size for type "${clean}". Use a standard <cstdint> type, pointer (e.g. "${clean}*"), array (e.g. "uint8_t[16]"), or provide explicit "size" in bytes.`
  );
}

/**
 * Computes the layout of a struct: sorts fields by offset, validates no overlaps,
 * inserts explicit char pad_XXXX[0x...] entries for gaps, and computes total size.
 */
export function computeStructLayout(structDef, arch, knownStructs = new Map(), knownEnums = new Map()) {
  const fields = (structDef.fields || []).map(field => {
    const offset = parseHex(field.offset);
    const resolved = resolveFieldType(field.type, arch, knownStructs, knownEnums, field.size);
    return {
      ...field,
      offsetNum: offset,
      offsetHex: formatHex(offset, 4),
      resolvedSize: resolved.size,
      endOffsetNum: offset + resolved.size,
      decl: resolved.formatDecl(field.name),
    };
  }).sort((a, b) => a.offsetNum - b.offsetNum);

  let baseSize = 0;
  if (structDef.inherits) {
    if (!knownStructs.has(structDef.inherits)) {
      throw new Error(`Struct "${structDef.name}" inherits from unknown struct "${structDef.inherits}".`);
    }
    baseSize = knownStructs.get(structDef.inherits) || 0;
  }

  const items = [];
  let cursor = baseSize;

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.offsetNum < baseSize) {
      throw new Error(
        `Field "${structDef.name}::${field.name}" at ${field.offsetHex} overlaps base class "${structDef.inherits}" (size ${formatHex(baseSize, 4)}).`
      );
    }
    if (field.offsetNum < cursor) {
      const prev = fields[i - 1];
      throw new Error(
        `Field overlap in struct "${structDef.name}": "${prev.name}" (${prev.offsetHex}..${formatHex(prev.endOffsetNum, 4)}, ${prev.resolvedSize}B) overlaps "${field.name}" at ${field.offsetHex}.`
      );
    }
    if (field.offsetNum > cursor) {
      const gap = field.offsetNum - cursor;
      const startHex = cursor.toString(16).toUpperCase().padStart(4, '0');
      items.push({
        kind: 'pad',
        name: `pad_${startHex}`,
        offsetNum: cursor,
        offsetHex: formatHex(cursor, 4),
        endOffsetHex: formatHex(field.offsetNum, 4),
        size: gap,
        sizeHex: formatHex(gap, 1),
        decl: `char pad_${startHex}[${formatHex(gap, 1)}]`,
      });
    }
    items.push({
      kind: 'field',
      ...field,
      endOffsetHex: formatHex(field.endOffsetNum, 4),
    });
    cursor = field.endOffsetNum;
  }

  let declaredSize = cursor;
  if (structDef.size !== undefined && structDef.size !== null && structDef.size !== '') {
    const targetSize = parseHex(structDef.size);
    if (targetSize < cursor) {
      throw new Error(
        `Struct "${structDef.name}" explicit size (${formatHex(targetSize, 4)}) is smaller than its last field end (${formatHex(cursor, 4)}).`
      );
    }
    if (targetSize > cursor) {
      const gap = targetSize - cursor;
      const startHex = cursor.toString(16).toUpperCase().padStart(4, '0');
      items.push({
        kind: 'pad',
        name: `pad_${startHex}`,
        offsetNum: cursor,
        offsetHex: formatHex(cursor, 4),
        endOffsetHex: formatHex(targetSize, 4),
        size: gap,
        sizeHex: formatHex(gap, 1),
        decl: `char pad_${startHex}[${formatHex(gap, 1)}]`,
      });
      declaredSize = targetSize;
    }
  }

  return {
    name: structDef.name,
    inherits: structDef.inherits || null,
    vtable: structDef.vtable || null,
    vtableMethods: [...(structDef.vtableMethods || [])].sort((a, b) => a.index - b.index),
    comment: structDef.comment || null,
    items,
    totalSize: declaredSize,
    totalSizeHex: formatHex(declaredSize, 4),
  };
}

export function readConfig(projectRoot) {
  const dataDir = dataDirName(projectRoot);
  let supplied;
  try {
    supplied = JSON.parse(readFileSync(join(projectRoot, dataDir, CONFIG_FILE), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    supplied = {};
  }
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) {
    throw new Error(`Invalid ${dataDir}/${CONFIG_FILE}`);
  }
  const config = {
    target: 'Win32 PE Binary',
    binaryPath: '',
    sha256: '',
    arch: 'x86',
    imageBase: '0x00400000',
    sdkHeaderPath: 'sdk/SDK.h',
    offsetsJsonPath: 'sdk/offsets.json',
    decompiledDirectory: 'decompiled',
    namespace: 'SDK',
    ...supplied,
    // Derived, not configurable: where the database lives relative to the project root.
    databasePath: `${dataDir}/${DATABASE_FILE}`,
  };
  if (!architectures.includes(config.arch)) {
    throw new Error(`reverser.config.json: arch must be one of ${architectures.join(', ')}.`);
  }
  if (typeof config.target !== 'string' || !config.target.trim()) {
    throw new Error('reverser.config.json: target must be a non-empty string.');
  }
  parseHex(config.imageBase);
  if (!validRelativePath(config.sdkHeaderPath)) {
    throw new Error('reverser.config.json: invalid sdkHeaderPath.');
  }
  if (!validRelativePath(config.offsetsJsonPath)) {
    throw new Error('reverser.config.json: invalid offsetsJsonPath.');
  }
  if (!validRelativePath(config.decompiledDirectory)) {
    throw new Error('reverser.config.json: invalid decompiledDirectory.');
  }
  if (config.namespace && !validIdentifier(config.namespace)) {
    throw new Error('reverser.config.json: namespace must be a valid C++ identifier or empty.');
  }
  if (config.context !== undefined) {
    const c = config.context;
    if (!c || typeof c !== 'object' || Array.isArray(c) ||
        (c.mode !== undefined && !['compact', 'full'].includes(c.mode)) ||
        (c.maxChars !== undefined && (!Number.isInteger(c.maxChars) || c.maxChars < 1500 || c.maxChars > 12000)) ||
        (c.symbols !== undefined && (!Array.isArray(c.symbols) || !c.symbols.every(validIdentifier)))) {
      throw new Error('Invalid context config: mode compact/full, maxChars 1500..12000, symbols identifier array.');
    }
  }
  return config;
}
