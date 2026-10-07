import { DurableObject } from 'cloudflare:workers';
import { MAX_ROOM_PARTICIPANTS } from '@duplex/protocol';
import type { ApiError } from '@duplex/protocol';

/**
 * One live Duplex room, addressed by its opaque room ID (`idFromName(roomId)`).
 *
 * A room is at most two participants plus ephemeral signaling and control state.
 * State lives in memory only: rooms are disposable by design, so nothing is persisted.
 * Signaling (WebSocket hibernation, offer/answer/ICE relay) is the next iteration.
 */
export class CallRoom extends DurableObject {
  static readonly capacity = MAX_ROOM_PARTICIPANTS;

  override fetch(): Response {
    const body: ApiError = {
      error: 'not_implemented',
      message: 'Room signaling is not implemented yet.',
    };
    return Response.json(body, { status: 501 });
  }
}
