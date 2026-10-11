// Pure audit of the helper's Tauri surface so it can be unit tested with mutated fixtures.
// Anything broader than this list (shell, filesystem, process, HTTP, opener, window or webview
// control, remote capabilities, a relaxed CSP, a new command) must be a deliberate, reviewed
// change to the constants below.

/** The only app commands the helper exposes. Mirrored in build.rs, lib.rs and the capability. */
export const ALLOWED_COMMANDS = [
  'connect_helper',
  'disconnect_helper',
  'get_native_input_status',
  'list_displays',
  'select_display',
  'request_accessibility',
  'refresh_accessibility_status',
  'stop_control',
];

/** The only built-in permissions the main window needs: `listen` and its cleanup `unlisten`. */
export const ALLOWED_CORE_PERMISSIONS = ['core:event:allow-listen', 'core:event:allow-unlisten'];

export const FORBIDDEN_PLUGINS = [
  'shell',
  'fs',
  'http',
  'process',
  'opener',
  'dialog',
  'clipboard-manager',
  'updater',
  'global-shortcut',
  'notification',
  'os',
  'upload',
  'websocket',
  'sql',
  'store',
  'stronghold',
  'deep-link',
  'autostart',
  'single-instance',
  'window-state',
  'log',
  'positioner',
  'cli',
  'localhost',
  'persisted-scope',
  'biometric',
  'barcode-scanner',
  'nfc',
  'geolocation',
  'haptics',
];

const toArray = (value) => (Array.isArray(value) ? value : []);

export const commandPermission = (command) => `allow-${command.replaceAll('_', '-')}`;

/**
 * @param {{ capabilities: Record<string, unknown>[], config: any, cargo: string, buildRs: string, libRs: string, capabilityFileCount?: number }} input
 * @returns {string[]} human-readable failures; empty when the surface is within policy
 */
export function auditTauri({ capabilities, config, cargo, buildRs, libRs }) {
  const failures = [];
  const fail = (message) => failures.push(message);

  if (capabilities.length !== 1)
    fail(`Expected exactly one capability file, found ${capabilities.length}.`);
  const expectedPermissions = [
    ...ALLOWED_CORE_PERMISSIONS,
    ...ALLOWED_COMMANDS.map(commandPermission),
  ].sort();
  for (const capability of capabilities) {
    const id = String(capability['identifier'] ?? 'capability');
    if (capability['remote']) fail(`${id}: remote capabilities must not be granted.`);
    if (capability['local'] === false) fail(`${id}: capability must stay local.`);
    if (capability['webviews']) fail(`${id}: grant windows, not webviews.`);
    if (capability['platforms']) fail(`${id}: platform scoping needs a reviewed change here.`);
    if (JSON.stringify(capability['windows']) !== '["main"]')
      fail(`${id}: only the main window may be granted.`);
    const permissions = toArray(capability['permissions']);
    for (const permission of permissions) {
      if (typeof permission !== 'string') {
        fail(
          `${id}: scoped or object permissions need a reviewed change: ${JSON.stringify(permission)}.`,
        );
        continue;
      }
      if (
        permission === 'core:default' ||
        permission.endsWith(':default') ||
        permission.includes('*')
      )
        fail(`${id}: broad permission ${JSON.stringify(permission)} is not allowed.`);
      const plugin = permission.split(':')[0]?.replace(/^plugin-/, '');
      if (permission.includes(':') && FORBIDDEN_PLUGINS.includes(plugin ?? ''))
        fail(`${id}: forbidden plugin permission ${JSON.stringify(permission)}.`);
      if (/^core:(window|webview|app|path|menu|tray|resources|image):/.test(permission))
        fail(`${id}: ${JSON.stringify(permission)} grants window, app or resource control.`);
      if (!expectedPermissions.includes(permission))
        fail(`${id}: permission ${JSON.stringify(permission)} is not on the reviewed allowlist.`);
    }
    const granted = [...permissions].filter((value) => typeof value === 'string').sort();
    for (const permission of expectedPermissions)
      if (!granted.includes(permission))
        fail(`${id}: expected permission ${permission} is missing.`);
    if (new Set(granted).size !== granted.length) fail(`${id}: duplicate permissions.`);
  }

  // The command list is declared three times (build.rs permissions, the invoke handler, the
  // capability). They must agree with each other and with the reviewed list.
  const buildCommands = [...(buildRs.match(/"([a-z_]+)"/g) ?? [])].map((item) => item.slice(1, -1));
  if (JSON.stringify([...buildCommands].sort()) !== JSON.stringify([...ALLOWED_COMMANDS].sort()))
    fail(`build.rs declares unexpected commands: ${buildCommands.join(', ')}.`);
  const handler = libRs.match(/generate_handler!\[([\s\S]*?)\]/)?.[1] ?? '';
  const handlerCommands = [...handler.matchAll(/(?:\w+::)*(\w+)/g)].map((match) => match[1]);
  const bareHandlers = handlerCommands.filter((name) => name !== 'bridge');
  if (JSON.stringify([...bareHandlers].sort()) !== JSON.stringify([...ALLOWED_COMMANDS].sort()))
    fail(`lib.rs registers unexpected commands: ${bareHandlers.join(', ')}.`);

  const csp = config.app?.security?.csp;
  if (typeof csp !== 'string') fail('tauri.conf.json: a CSP must be configured.');
  else {
    for (const directive of [
      "default-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ])
      if (!csp.includes(directive)) fail(`CSP is missing ${directive}.`);
    if (/unsafe-eval|\*|https?:|wss?:/.test(csp))
      fail('CSP must not allow eval, wildcards or remote origins.');
    for (const part of csp.split(';'))
      if (/\bdata:|\bblob:/.test(part) && !part.trim().startsWith('img-src'))
        fail('CSP may only allow data: URIs for images.');
    const scriptSrc = csp.split(';').find((part) => part.trim().startsWith('script-src'));
    if (scriptSrc?.includes('unsafe-inline'))
      fail("CSP script-src must not allow 'unsafe-inline'.");
    if (/(^|;)\s*connect-src/.test(csp))
      fail('CSP must not open connect-src; the UI only uses IPC.');
  }
  const security = config.app?.security ?? {};
  if (config.app?.withGlobalTauri) fail('withGlobalTauri exposes the Tauri API to every script.');
  if (security.dangerousDisableAssetCspModification)
    fail('dangerousDisableAssetCspModification must stay off.');
  if (security.assetProtocol?.enable) fail('The asset protocol must stay disabled.');
  if (security.dangerousRemoteDomainIpcAccess) fail('Remote IPC access must stay unset.');
  if (security.capabilities) fail('Inline capabilities bypass the reviewed capability file.');
  if (security.pattern && security.pattern.use !== 'brownfield')
    fail('Isolation pattern changes need a reviewed update here.');
  const windows = toArray(config.app?.windows);
  if (windows.some((window) => window.label !== 'main' || window.url))
    fail('Only the local main window may exist; no extra windows or remote window URLs.');
  if (Object.keys(config.plugins ?? {}).length > 0)
    fail('tauri.conf.json must not configure plugins.');
  if (config.build?.devUrl && !/^http:\/\/localhost:\d+$/.test(config.build.devUrl))
    fail('devUrl must stay on localhost.');

  for (const plugin of FORBIDDEN_PLUGINS)
    if (new RegExp(`tauri-plugin-${plugin}\\b`).test(cargo))
      fail(`Cargo.toml depends on tauri-plugin-${plugin}; the helper must not.`);
  if (/tauri-plugin-/.test(cargo)) fail('Cargo.toml adds a Tauri plugin; review its permissions.');
  if (/tauri\s*=\s*\{[^}]*features\s*=\s*\[[^\]]+\]/.test(cargo))
    fail('The tauri crate must not enable extra features without review.');
  for (const dangerous of ['Command::new', 'std::process', 'tokio::process', 'reqwest'])
    if (libRs.includes(dangerous)) fail(`lib.rs uses ${dangerous}.`);

  return failures;
}
