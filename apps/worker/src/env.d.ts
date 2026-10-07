import type { CallRoom } from './call-room';

declare global {
  namespace Cloudflare {
    interface Env {
      CALL_ROOM: DurableObjectNamespace<CallRoom>;
    }
  }
}
