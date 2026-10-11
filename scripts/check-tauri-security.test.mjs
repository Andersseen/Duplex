import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ALLOWED_COMMANDS, auditTauri, commandPermission } from './lib/tauri-security.mjs';

const read = (path) =>
  readFile(fileURLToPath(new URL(`../apps/helper/src-tauri/${path}`, import.meta.url)), 'utf8');
const baseline = async () => ({
  capabilities: [JSON.parse(await read('capabilities/default.json'))],
  config: JSON.parse(await read('tauri.conf.json')),
  cargo: await read('Cargo.toml'),
  buildRs: await read('build.rs'),
  libRs: await read('src/lib.rs'),
});
/** Audits a deep copy of the real configuration after `mutate` has loosened it. */
async function audit(mutate = () => {}) {
  const input = structuredClone(await baseline());
  mutate(input);
  return auditTauri(input);
}
const rejects = async (mutate, pattern) => {
  const failures = await audit(mutate);
  assert.ok(
    failures.some((failure) => pattern.test(failure)),
    `expected ${pattern}, got: ${failures.join(' | ')}`,
  );
};

test('the committed helper configuration passes', async () => {
  assert.deepEqual(await audit(), []);
});

test('the capability is exactly the reviewed allowlist', async () => {
  const [capability] = (await baseline()).capabilities;
  assert.deepEqual(
    [...capability.permissions].sort(),
    [
      'core:event:allow-listen',
      'core:event:allow-unlisten',
      ...ALLOWED_COMMANDS.map(commandPermission),
    ].sort(),
  );
  assert.deepEqual(capability.windows, ['main']);
});

test('broad or forbidden permissions are rejected', async () => {
  for (const permission of [
    'core:default',
    'core:window:default',
    'core:window:allow-close',
    'core:webview:allow-create-webview-window',
    'core:app:allow-app-hide',
    'core:path:default',
    'core:event:default',
    'shell:allow-execute',
    'shell:default',
    'fs:default',
    'http:default',
    'process:allow-exit',
    'opener:default',
    'dialog:default',
    'clipboard-manager:allow-read-text',
    'allow-new-command',
    'core:event:allow-emit',
  ])
    await rejects(
      (input) => input.capabilities[0].permissions.push(permission),
      /allowlist|broad|forbidden|control/,
    );
});

test('removing an expected permission is flagged', async () => {
  await rejects((input) => input.capabilities[0].permissions.pop(), /missing/);
});

test('scoped permission objects, remote access and extra windows are rejected', async () => {
  await rejects(
    (input) =>
      input.capabilities[0].permissions.push({
        identifier: 'fs:allow-read',
        allow: [{ path: '*' }],
      }),
    /scoped/,
  );
  await rejects((input) => (input.capabilities[0].remote = { urls: ['https://*'] }), /remote/);
  await rejects((input) => (input.capabilities[0].windows = ['main', 'other']), /main window/);
  await rejects(
    (input) => input.capabilities.push({ identifier: 'extra', windows: ['main'], permissions: [] }),
    /exactly one/,
  );
  await rejects(
    (input) => input.config.app.windows.push({ label: 'popup', url: 'https://example.com' }),
    /extra windows/,
  );
});

test('unexpected commands are rejected in build.rs and the invoke handler', async () => {
  await rejects(
    (input) =>
      (input.buildRs = input.buildRs.replace('"stop_control"', '"stop_control", "run_shell"')),
    /build.rs/,
  );
  await rejects(
    (input) =>
      (input.libRs = input.libRs.replace(
        'bridge::stop_control',
        'bridge::stop_control, bridge::run_shell',
      )),
    /lib.rs registers/,
  );
});

test('dangerous CSP and Tauri security changes are rejected', async () => {
  const csp = (input) => input.config.app.security.csp;
  await rejects(
    (input) => (input.config.app.security.csp = `${csp(input)}; script-src 'unsafe-inline'`),
    /unsafe-inline/,
  );
  await rejects((input) => (input.config.app.security.csp = `${csp(input)} 'unsafe-eval'`), /eval/);
  await rejects(
    (input) => (input.config.app.security.csp = `${csp(input)}; connect-src https://evil.example`),
    /remote origins|connect-src/,
  );
  await rejects(
    (input) => (input.config.app.security.csp = csp(input).replace("object-src 'none'", '')),
    /object-src/,
  );
  await rejects(
    (input) =>
      (input.config.app.security.csp = csp(input).replace(
        "frame-ancestors 'none'",
        'frame-ancestors *',
      )),
    /frame-ancestors|wildcards/,
  );
  await rejects((input) => (input.config.app.withGlobalTauri = true), /withGlobalTauri/);
  await rejects(
    (input) => (input.config.app.security.assetProtocol = { enable: true }),
    /asset protocol/,
  );
  await rejects(
    (input) => (input.config.app.security.dangerousDisableAssetCspModification = true),
    /dangerous/,
  );
  await rejects(
    (input) => (input.config.app.security.capabilities = ['inline']),
    /Inline capabilities/,
  );
  await rejects((input) => (input.config.plugins = { shell: { open: true } }), /plugins/);
  await rejects((input) => (input.config.build.devUrl = 'https://evil.example'), /localhost/);
});

test('plugin crates and process or network access are rejected', async () => {
  for (const plugin of ['shell', 'fs', 'http', 'process', 'opener', 'dialog'])
    await rejects((input) => (input.cargo += `\ntauri-plugin-${plugin} = "2"\n`), /tauri-plugin/);
  await rejects((input) => (input.cargo += '\ntauri-plugin-custom = "2"\n'), /adds a Tauri plugin/);
  await rejects(
    (input) =>
      (input.cargo = input.cargo.replace(
        'tauri = { version = "2", features = [] }',
        'tauri = { version = "2", features = ["protocol-asset"] }',
      )),
    /extra features/,
  );
  await rejects(
    (input) => (input.libRs += '\nfn x() { std::process::Command::new("sh"); }'),
    /uses/,
  );
});
