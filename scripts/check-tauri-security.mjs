// Guards the helper's narrow Tauri surface. The helper only needs its own commands plus the
// default event access for state pushes, so anything broader (shell, filesystem, process, HTTP,
// remote capabilities, a relaxed CSP) must be a deliberate, reviewed change to this file.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../apps/helper/src-tauri/', import.meta.url));
const failures = [];
const fail = (message) => failures.push(message);

const ALLOWED_PERMISSIONS = new Set([
  'core:default',
  'allow-connect-helper',
  'allow-disconnect-helper',
  'allow-get-native-input-status',
  'allow-list-displays',
  'allow-select-display',
  'allow-request-accessibility',
  'allow-refresh-accessibility-status',
  'allow-stop-control',
]);

const capabilityFiles = (await readdir(join(root, 'capabilities'))).filter((name) =>
  name.endsWith('.json'),
);
if (capabilityFiles.length !== 1)
  fail(`Expected exactly one capability file, found ${capabilityFiles.length}.`);
for (const file of capabilityFiles) {
  const capability = JSON.parse(await readFile(join(root, 'capabilities', file), 'utf8'));
  if (capability.remote) fail(`${file}: remote capabilities must not be granted.`);
  if (JSON.stringify(capability.windows) !== '["main"]')
    fail(`${file}: only the main window may be granted.`);
  for (const permission of capability.permissions) {
    if (typeof permission !== 'string' || !ALLOWED_PERMISSIONS.has(permission))
      fail(`${file}: permission ${JSON.stringify(permission)} is not on the reviewed allowlist.`);
  }
}

const config = JSON.parse(await readFile(join(root, 'tauri.conf.json'), 'utf8'));
const csp = config.app?.security?.csp;
if (typeof csp !== 'string') fail('tauri.conf.json: a CSP must be configured.');
else {
  for (const directive of [
    "default-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ])
    if (!csp.includes(directive)) fail(`CSP is missing ${directive}.`);
  if (/unsafe-eval|\*|https?:/.test(csp))
    fail('CSP must not allow eval, wildcards or remote origins.');
}
if (config.app?.withGlobalTauri) fail('withGlobalTauri exposes the Tauri API to every script.');
if (config.app?.security?.dangerousDisableAssetCspModification)
  fail('dangerousDisableAssetCspModification must stay off.');
if (config.app?.security?.assetProtocol?.enable) fail('The asset protocol must stay disabled.');

const cargo = await readFile(join(root, 'Cargo.toml'), 'utf8');
for (const plugin of [
  'tauri-plugin-shell',
  'tauri-plugin-fs',
  'tauri-plugin-http',
  'tauri-plugin-process',
  'tauri-plugin-opener',
])
  if (cargo.includes(plugin)) fail(`Cargo.toml depends on ${plugin}; the helper must not.`);
if (/tauri\s*=\s*\{[^}]*features\s*=\s*\[[^\]]+\]/.test(cargo))
  fail('The tauri crate must not enable extra features without review.');

if (failures.length) {
  console.error(`Tauri security check failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('Tauri security check passed: narrow capability, strict CSP, no powerful plugins.');
