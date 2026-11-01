// Child process: applies N patches adding distinct fields to struct "Shared".
import { runUpdate } from '../src/engine/index.mjs';

const [root, tag, count] = process.argv.slice(2);
const base = tag === 'a' ? 0x1000 : 0x2000;
for (let i = 0; i < Number(count); i++) {
  await runUpdate(root, {
    structs: [{ name: 'Shared', fields: [{ offset: `0x${(base + i * 4).toString(16)}`, name: `${tag}${i}`, type: 'uint32_t' }] }],
  }, { lockTimeoutMs: 30_000 });
}
