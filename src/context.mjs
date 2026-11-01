// Model context only: never changes the canonical SDK or memory map.
export function compactContext(state, config, prompt = '') {
  const options = config.context || {};
  const budget = Math.max(1500, Math.min(12000, options.maxChars ?? 6000));
  const pins = new Set(options.symbols || []);
  const mentioned = name => new RegExp(`\\b${name}\\b`, 'i').test(prompt);
  const lines = [
    '# Reverser — compact context',
    `Target: ${config.target}; ${config.arch}; base ${config.imageBase}; SHA-256 ${config.sha256 || 'unspecified'}.`,
    `Canonical data: ${config.databasePath ?? '.reverser/reverser.json'}; header: ${config.sdkHeaderPath}; offsets: ${config.offsetsJsonPath}; pseudocode: ${config.decompiledDirectory}/.`,
    'Read relevant canonical entries before analysis. Update verified discoveries only via patches (`reverser update`); query with `reverser search` / `reverser show`. Never hand-edit generated padding. Use strict C++ types; preserve confidence and evidence; unknown types are not confirmed.',
    `Database: ${(state.structs || []).length} structs, ${(state.functions || []).length} functions. Below is a partial view, not the whole SDK. Missing symbols/fields are NOT evidence of absence.`,
  ];
  const entries = [];
  for (const kind of ['structs', 'functions', 'globals', 'enums']) {
    for (const item of state[kind] || []) {
      if (!pins.has(item.name) && !mentioned(item.name)) continue;
      let text = `${kind}: ${item.name}`;
      if (kind === 'structs') {
        text += ` size=${item.size || '?'} vtable=${item.vtable || '?'}\n`;
        text += (item.fields || []).map(f => `  ${f.offset} ${f.type} ${f.name} [${f.confidence || 'unspecified'}]`).join('\n');
      } else text += ` ${item.address || ''} ${item.signature || item.type || ''} [${item.confidence || 'unspecified'}]`;
      if (item.comment) text += `\n  ${item.comment}`;
      entries.push({ text, score: mentioned(item.name) ? 0 : 1 });
    }
  }
  entries.sort((a, b) => a.score - b.score);
  let omitted = 0;
  for (const { text } of entries) {
    if (lines.join('\n').length + text.length + 150 <= budget) lines.push(text);
    else omitted++;
  }
  if (omitted) lines.push(`${omitted} selected entries omitted by budget; read canonical files for details.`);
  return lines.join('\n');
}

