import { addScriptHashes, angularInlineScriptHashes } from '../csp';

interface ResponseLike {
  getHeader(name: string): unknown;
  setHeader(name: string, value: string): unknown;
}
interface NitroAppLike {
  hooks: {
    hook(
      name: 'beforeResponse',
      handler: (
        event: { node: { res: ResponseLike } },
        response: { body?: unknown },
      ) => Promise<void>,
    ): void;
  };
}

/**
 * Allows exactly the inline scripts Angular rendered into this response by adding their hashes to
 * `script-src`. Hashes (not a nonce) are used so SSR responses and prerendered static pages share
 * one mechanism: static assets are served without running the Worker and cannot carry a per-response nonce.
 */
export default (nitroApp: NitroAppLike): void => {
  nitroApp.hooks.hook('beforeResponse', async (event, response) => {
    const policy = event.node.res.getHeader('content-security-policy');
    if (typeof policy !== 'string' || typeof response.body !== 'string') return;
    const hashes = await angularInlineScriptHashes(response.body);
    event.node.res.setHeader('content-security-policy', addScriptHashes(policy, hashes));
  });
};
