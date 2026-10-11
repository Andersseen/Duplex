// Content-Security-Policy helpers for the production web Worker. No imports on purpose: the same
// file is bundled into the Nitro server and loaded directly by `scripts/apply-static-csp.mjs`.

/** Angular's event-replay bootstrap: the contract runtime plus the call that registers event types. */
const CONTRACT_SCRIPT =
  /<script type="text\/javascript" id="ng-event-dispatch-contract">([\s\S]*?)<\/script>/g;
const BOOTSTRAP_SCRIPT =
  /<script>(window\.__jsaction_bootstrap\(document\.body,"ng",\[(?:"[a-z]+",?)*\],\[(?:"[a-z]+",?)*\]\);)<\/script>/g;

/**
 * Returns `'sha256-…'` source expressions for the only inline scripts Angular's SSR output emits
 * (the event-replay contract and its bootstrap call). Any other inline script, including one
 * injected into the markup, is deliberately left out so the browser blocks it.
 */
export async function angularInlineScriptHashes(html: string): Promise<string[]> {
  const bodies = new Set<string>();
  for (const pattern of [CONTRACT_SCRIPT, BOOTSTRAP_SCRIPT])
    for (const match of html.matchAll(pattern)) if (match[1]) bodies.add(match[1]);
  const hashes: string[] = [];
  for (const body of bodies) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
    hashes.push(`'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`);
  }
  return hashes.sort();
}

/** Appends hash sources to the `script-src` directive; a policy without one is returned unchanged. */
export function addScriptHashes(policy: string, hashes: readonly string[]): string {
  if (hashes.length === 0) return policy;
  return policy
    .split(';')
    .map((directive) =>
      directive.trim().startsWith('script-src ')
        ? `${directive.trim()} ${hashes.join(' ')}`
        : directive.trim(),
    )
    .join('; ');
}
