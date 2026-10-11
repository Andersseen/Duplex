// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { addScriptHashes, angularInlineScriptHashes } from './csp';

const CONTRACT =
  '<script type="text/javascript" id="ng-event-dispatch-contract">(()=>{if(1<2){window.__jsaction_bootstrap=1}})();</script>';
const BOOTSTRAP =
  '<script>window.__jsaction_bootstrap(document.body,"ng",["click","input"],[]);</script>';

async function sha256(body: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  return `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`;
}

describe('angularInlineScriptHashes', () => {
  it('hashes the event contract (even though it contains "<") and its bootstrap call', async () => {
    const hashes = await angularInlineScriptHashes(`<body>${CONTRACT}${BOOTSTRAP}</body>`);
    expect(hashes).toEqual(
      [
        await sha256('(()=>{if(1<2){window.__jsaction_bootstrap=1}})();'),
        await sha256('window.__jsaction_bootstrap(document.body,"ng",["click","input"],[]);'),
      ].sort(),
    );
  });

  it('never hashes data blocks, external scripts or arbitrary inline code', async () => {
    const html = [
      '<script id="ng-state" type="application/json">{"a":1}</script>',
      '<script type="module" src="/assets/index.js"></script>',
      '<script>alert(document.domain)</script>',
      '<script>window.__jsaction_bootstrap(document.body,"ng",["click"],[]);alert(1)</script>',
      '<script>window.__jsaction_bootstrap(document.body,"ng",["click"],[]);</script ><script>evil()</script>',
    ].join('');
    expect(await angularInlineScriptHashes(html)).toEqual([]);
  });

  it('is stable for identical output and deduplicates repeats', async () => {
    const once = await angularInlineScriptHashes(BOOTSTRAP);
    expect(await angularInlineScriptHashes(BOOTSTRAP + BOOTSTRAP)).toEqual(once);
  });
});

describe('addScriptHashes', () => {
  const policy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'";

  it('appends hashes only to script-src and never adds unsafe-inline or unsafe-eval', () => {
    const result = addScriptHashes(policy, ["'sha256-abc='"]);
    expect(result).toBe(
      "default-src 'self'; script-src 'self' 'sha256-abc='; style-src 'self' 'unsafe-inline'",
    );
    expect(result.split(';')[1]).not.toMatch(/unsafe-(inline|eval)/);
  });

  it('leaves the policy untouched without hashes', () => {
    expect(addScriptHashes(policy, [])).toBe(policy);
  });
});
