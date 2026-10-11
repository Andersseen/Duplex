// Guards the helper's narrow Tauri surface; the rules live in scripts/lib/tauri-security.mjs.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditTauri } from './lib/tauri-security.mjs';

const root = fileURLToPath(new URL('../apps/helper/src-tauri/', import.meta.url));
const capabilityFiles = (await readdir(join(root, 'capabilities'))).filter((name) =>
  name.endsWith('.json'),
);
const failures = auditTauri({
  capabilities: await Promise.all(
    capabilityFiles.map(async (file) =>
      JSON.parse(await readFile(join(root, 'capabilities', file), 'utf8')),
    ),
  ),
  config: JSON.parse(await readFile(join(root, 'tauri.conf.json'), 'utf8')),
  cargo: await readFile(join(root, 'Cargo.toml'), 'utf8'),
  buildRs: await readFile(join(root, 'build.rs'), 'utf8'),
  libRs: await readFile(join(root, 'src/lib.rs'), 'utf8'),
});

if (failures.length) {
  console.error(`Tauri security check failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('Tauri security check passed: explicit minimal permissions, strict CSP, no plugins.');
