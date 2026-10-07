import type { CallRoom } from './call-room';

declare global {
  namespace Cloudflare {
    interface Env {
      CALL_ROOM: DurableObjectNamespace<CallRoom>;
      /** Secrets configured with `wrangler secret put`. */
      TURN_KEY_ID?: string;
      TURN_KEY_API_TOKEN?: string;
      /** Comma-separated exact browser origins, for example https://call.example.com. */
      ALLOWED_ORIGINS?: string;
      ENVIRONMENT?: string;
    }
  }
}
