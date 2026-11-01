import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import { readConfig, formatHex, parseHex, pointerSize } from './config.mjs';
import { validateAndLayoutState } from './codegen.mjs';
import { DATABASE_FILE, dataDirName } from './layout.mjs';
import { minimapRows, minimapOffset } from './minimap.mjs';

const file = resolve(process.argv[2] || join(dataDirName(process.cwd()), DATABASE_FILE));
let previous;
let currentState;
let baseline;
let offset = 0;
let content = [];

// Keep ANSI highlights but clip long rows so terminal wrapping cannot hide rows.
function clip(line, width) {
  let visible = 0;
  let result = '';
  for (const token of line.match(/\x1b\[[0-9;]*m|[^]/gu) || []) {
    if (token.startsWith('\x1b')) result += token;
    else {
      if (visible >= width) break;
      result += token;
      visible++;
    }
  }
  return result + '\x1b[0m';
}

function draw() {
  const height = Math.max(1, process.stdout.rows || 24);
  const columns = process.stdout.columns || 80;
  const showMap = columns >= 4;
  const width = Math.max(1, columns - 1 - (showMap ? 2 : 0));
  offset = Math.max(0, Math.min(offset, Math.max(0, content.length - height)));
  const map = showMap ? minimapRows(content, offset, height) : [];
  const page = Array.from({ length: height }, (_, row) => {
    const line = content[offset + row] || '';
    const text = clip(line, width);
    // Absolute cursor positioning avoids counting ANSI escapes or wide glyphs.
    return showMap ? `${text}\x1b[${width + 1}G${map[row]}` : text;
  });
  process.stdout.write('\x1b[H\x1b[2J' + page.join('\r\n'));
}

function scroll(amount) {
  offset += amount;
  draw();
}

const safe = value => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const colors = {
  added: '\x1b[42;30m',
  changed: '\x1b[43;30m',
  removed: '\x1b[41;37m',
  dim: '\x1b[90m',
  cyan: '\x1b[36m',
};
const mark = (text, kind) =>
  kind
    ? `${colors[kind]}${kind === 'added' ? '+' : kind === 'removed' ? '−' : '~'} ${text}\x1b[0m`
    : `  ${text}`;
const kind = (old, value) => (!baseline ? undefined : old === undefined ? 'added' : same(old, value) ? undefined : 'changed');

function render() {
  try {
    const raw = readFileSync(file, 'utf8');
    const config = readConfig(dirname(dirname(file)));
    const key = `${process.stdout.columns}:${process.stdout.rows}:${JSON.stringify(config)}:${raw}`;
    if (key === previous) return;
    const state = JSON.parse(raw);
    const stateChanged = currentState !== undefined && !same(currentState, state);
    if (stateChanged) baseline = currentState;
    currentState = state;
    previous = key;

    const { layouts } = validateAndLayoutState(state, config);
    const lines = [
      `TARGET · ${safe(config.target)} (${safe(config.arch)}, base ${safe(config.imageBase)})`,
      `OUTPUT · ${safe(config.sdkHeaderPath)} | ${safe(config.offsetsJsonPath)} | ${safe(config.decompiledDirectory)}/`,
    ];
    if (config.sha256) lines.push(`SHA256 · ${safe(config.sha256)}`);

    const removed = [];

    // 1. STRUCTS & SDK LAYOUT
    lines.push('', `STRUCTS (${layouts.length})`);
    if (!layouts.length) {
      lines.push('  No reconstructed structs yet.');
    }
    for (const layout of layouts) {
      const currentStruct = state.structs.find(s => s.name === layout.name);
      const oldStruct = baseline?.structs?.find(s => s.name === layout.name);
      const structHeaderChange = !baseline
        ? undefined
        : !oldStruct
          ? 'added'
          : oldStruct.inherits !== currentStruct.inherits ||
              oldStruct.vtable !== currentStruct.vtable ||
              oldStruct.size !== currentStruct.size
            ? 'changed'
            : undefined;

      const meta = [`size: ${layout.totalSizeHex}`];
      if (layout.inherits) meta.unshift(`: ${safe(layout.inherits)}`);
      if (layout.vtable) meta.push(`vtable: ${formatHex(parseHex(layout.vtable), 8)}`);

      lines.push('', mark(`struct ${safe(layout.name)} [${meta.join(' | ')}]`, structHeaderChange));

      for (const vm of layout.vtableMethods) {
        const oldVm = oldStruct?.vtableMethods?.find(m => m.index === vm.index);
        const slotOff = formatHex(vm.index * pointerSize(config.arch), 2);
        const addrStr = vm.address ? ` @ ${formatHex(parseHex(vm.address), 8)}` : '';
        const sigStr = vm.signature ? ` ${safe(vm.signature)}` : '';
        lines.push(mark(`  [vtbl #${vm.index} +${slotOff}] ${safe(vm.name)}${addrStr}${sigStr}`, kind(oldVm, vm)));
      }
      for (const oldVm of oldStruct?.vtableMethods || []) {
        if (!layout.vtableMethods.some(m => m.index === oldVm.index)) {
          removed.push(`VTable: ${safe(layout.name)}[#${oldVm.index}] (${safe(oldVm.name)})`);
        }
      }

      for (const item of layout.items) {
        if (item.kind === 'pad') {
          lines.push(`  ${colors.dim}  ${item.offsetHex}..${item.endOffsetHex}  ${item.decl};${'\x1b[0m'}`);
        } else {
          const oldField = oldStruct?.fields?.find(
            f => f.name === item.name || parseHex(f.offset) === item.offsetNum
          );
          const rawField = currentStruct.fields.find(f => f.name === item.name);
          const confTag =
            item.confidence === 'guessed'
              ? ' [?]'
              : item.confidence === 'probable'
                ? ' [~]'
                : '';
          const cmt = item.comment ? ` // ${safe(item.comment)}` : '';
          lines.push(
            mark(
              `  ${item.offsetHex} (${formatHex(item.resolvedSize, 1)})  ${safe(item.decl)};${confTag}${cmt}`,
              kind(oldField, rawField)
            )
          );
        }
      }

      for (const oldField of oldStruct?.fields || []) {
        if (!currentStruct.fields.some(f => f.name === oldField.name)) {
          removed.push(`Field: ${safe(layout.name)}::${safe(oldField.name)} (${safe(oldField.offset)})`);
        }
      }
    }
    for (const oldStruct of baseline?.structs || []) {
      if (!state.structs?.some(s => s.name === oldStruct.name)) {
        removed.push(`Struct: ${safe(oldStruct.name)}`);
      }
    }

    // 2. ENUMS
    if (state.enums?.length) {
      lines.push('', `ENUMS (${state.enums.length})`);
      for (const en of state.enums) {
        const oldEn = baseline?.enums?.find(e => e.name === en.name);
        lines.push(mark(`enum ${safe(en.name)} : ${safe(en.underlyingType || 'uint32_t')}`, kind(oldEn, en)));
        for (const val of en.values || []) {
          const oldVal = oldEn?.values?.find(v => v.name === val.name);
          lines.push(mark(`  ${safe(val.name)} = ${formatHex(parseHex(val.value), 1)}`, kind(oldVal, val)));
        }
      }
    }
    for (const oldEn of baseline?.enums || []) {
      if (!state.enums?.some(e => e.name === oldEn.name)) removed.push(`Enum: ${safe(oldEn.name)}`);
    }

    // 3. GLOBALS & POINTER CHAINS
    lines.push('', `GLOBALS (${state.globals?.length || 0})`);
    if (!state.globals?.length) {
      lines.push('  No global addresses recorded.');
    }
    for (const g of state.globals || []) {
      const oldG = baseline?.globals?.find(item => item.name === g.name);
      const addrHex = formatHex(parseHex(g.address), 8);
      const chain = g.pointerChain?.length ? ` -> [${g.pointerChain.map(safe).join(' -> ')}]` : '';
      const cmt = g.comment ? ` // ${safe(g.comment)}` : '';
      lines.push(mark(`${addrHex}  ${safe(g.name)}: ${safe(g.type)}${chain}${cmt}`, kind(oldG, g)));
    }
    for (const oldG of baseline?.globals || []) {
      if (!state.globals?.some(g => g.name === oldG.name)) removed.push(`Global: ${safe(oldG.name)}`);
    }

    // 4. FUNCTIONS & DECOMPILED INDEX
    lines.push('', `FUNCTIONS (${state.functions?.length || 0})`);
    if (!state.functions?.length) {
      lines.push('  No mapped functions.');
    }
    const sortedFns = [...(state.functions || [])].sort((a, b) => parseHex(a.address) - parseHex(b.address));
    for (const fn of sortedFns) {
      const addrHex = formatHex(parseHex(fn.address), 8);
      const oldFn = baseline?.functions?.find(
        item => formatHex(parseHex(item.address), 8) === addrHex || item.name === fn.name
      );
      const conv = fn.callingConvention ? `[${safe(fn.callingConvention)}] ` : '';
      const sig = fn.signature ? ` : ${safe(fn.signature)}` : '';
      const fileRef = fn.decompiledFile ? ` -> ${safe(fn.decompiledFile)}` : '';
      lines.push(mark(`${addrHex}  ${conv}${safe(fn.name)}${sig}${fileRef}`, kind(oldFn, fn)));
    }
    for (const oldFn of baseline?.functions || []) {
      const oldAddr = formatHex(parseHex(oldFn.address), 8);
      if (!state.functions?.some(f => formatHex(parseHex(f.address), 8) === oldAddr)) {
        removed.push(`Function: ${oldAddr} ${safe(oldFn.name)}`);
      }
    }

    if (removed.length) {
      lines.push('', 'REMOVED IN LAST UPDATE', ...removed.map(text => mark(text, 'removed')));
    }

    content = lines.flatMap(line => line.split('\n'));
    if (stateChanged) {
      const firstChange = content.findIndex(line =>
        [colors.added, colors.changed, colors.removed].some(color => line.startsWith(color))
      );
      if (firstChange >= 0) offset = Math.max(0, firstChange - 2);
    }
    draw();
  } catch (error) {
    content = [safe(error.message)];
    draw();
    previous = undefined;
  }
}

process.stdout.write(`\x1b]0;Reverser: ${safe(file)}\x07\x1b[?1049h\x1b[?25l`);

function stop() {
  process.stdout.write('\x1b[?1000l\x1b[?1006l\x1b[0m\x1b[?25h\x1b[?1049l');
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.exit();
}

if (process.stdin.isTTY) {
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write('\x1b[?1000h\x1b[?1006h');
  process.stdin.on('keypress', (text, key) => {
    if ((key?.ctrl && key.name === 'c') || text === 'q') return stop();
    const page = Math.max(1, (process.stdout.rows || 24) - 2);
    if (key?.name === 'up' || text === 'k') scroll(-1);
    else if (key?.name === 'down' || text === 'j') scroll(1);
    else if (key?.name === 'pageup') scroll(-page);
    else if (key?.name === 'pagedown' || text === ' ') scroll(page);
    else if (key?.name === 'home' || text === 'g') {
      offset = 0;
      draw();
    } else if (key?.name === 'end' || text === 'G') {
      offset = content.length;
      draw();
    }
  });
  let mouseBuffer = '';
  process.stdin.on('data', chunk => {
    mouseBuffer += chunk.toString();
    for (const match of mouseBuffer.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)) {
      const button = Number(match[1]);
      const column = Number(match[2]);
      const row = Number(match[3]);
      if (button & 64 && match[4] === 'M') scroll(button & 1 ? 3 : -3);
      else if (button === 0 && match[4] === 'M') {
        const columns = process.stdout.columns || 80;
        if (columns >= 4 && column >= columns - 2 && column < columns) {
          offset = minimapOffset(row, Math.max(1, process.stdout.rows || 24), content.length);
          draw();
        }
      }
    }
    const start = mouseBuffer.lastIndexOf('\x1b[<');
    mouseBuffer =
      start >= 0 && !/[Mm]/.test(mouseBuffer.slice(start)) ? mouseBuffer.slice(start).slice(-64) : '';
  });
}

process.stdout.on('resize', () => {
  previous = undefined;
  render();
});
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
render();
setInterval(render, 500);
