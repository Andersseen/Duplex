/**
 * Wire protocol version. Bump on any breaking change to a message schema so that
 * a peer running an older client can be rejected explicitly instead of misparsing.
 */
export const PROTOCOL_VERSION = 1;

/** A room holds at most two participants: Duplex is 1:1 by design. */
export const MAX_ROOM_PARTICIPANTS = 2;
