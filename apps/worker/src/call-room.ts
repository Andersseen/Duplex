import { DurableObject } from 'cloudflare:workers';
import {
  MAX_ROOM_PARTICIPANTS,
  PROTOCOL_VERSION,
  clientSignalingMessageSchema,
  protocolErrorMessageSchema,
  roomFullMessageSchema,
  serverSignalingMessageSchema,
  helperOutboundMessageSchema,
} from '@duplex/protocol';
import type { ServerSignalingMessage } from '@duplex/protocol';
import { z } from 'zod';
import { generateRtcConfiguration } from './rtc-config';

const MAX_MESSAGE_BYTES = 128 * 1024;
/** A validated pointer input envelope is a few hundred bytes; reject anything padded beyond that. */
const MAX_HELPER_INPUT_BYTES = 1024;
const participantAttachmentSchema = z
  .object({
    kind: z.literal('participant'),
    participantId: z.string().min(16).max(64),
    joined: z.boolean(),
    polite: z.boolean().optional(),
    protocolVersion: z.number().int().positive().optional(),
    lastRtcConfigIssuedAt: z.number().int().nonnegative().optional(),
    helperPairingTokenHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    helperPairingExpiresAt: z.number().int().positive().optional(),
    helperPaired: z.boolean().optional(),
  })
  .strict();
const helperAttachmentSchema = z
  .object({
    kind: z.literal('helper'),
    helperId: z.string().min(16).max(64),
    ownerParticipantId: z.string().min(16).max(64),
    pairedAt: z.number().int().positive(),
  })
  .strict();
const attachmentSchema = z.discriminatedUnion('kind', [
  participantAttachmentSchema,
  helperAttachmentSchema,
]);
type ParticipantAttachment = z.infer<typeof participantAttachmentSchema>;

function randomParticipantId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function attachment(socket: WebSocket): z.infer<typeof attachmentSchema> | null {
  const parsed = attachmentSchema.safeParse(socket.deserializeAttachment());
  return parsed.success ? parsed.data : null;
}

function send(socket: WebSocket, message: ServerSignalingMessage): void {
  const parsed = serverSignalingMessageSchema.safeParse(message);
  if (parsed.success && socket.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify(parsed.data));
}

function sendProtocolError(
  socket: WebSocket,
  code: 'protocol_mismatch' | 'invalid_message' | 'not_joined',
  message: string,
): void {
  send(
    socket,
    protocolErrorMessageSchema.parse({
      type: 'protocol-error',
      payload: {
        code,
        message,
        ...(code === 'protocol_mismatch' ? { expectedVersion: PROTOCOL_VERSION } : {}),
      },
    }),
  );
}

export class CallRoom extends DurableObject {
  static readonly capacity = MAX_ROOM_PARTICIPANTS;

  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname.endsWith('/helper/ws')) return this.connectHelper(request);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return Response.json(
        { error: 'websocket_required', message: 'This endpoint requires a WebSocket upgrade.' },
        { status: 426, headers: { Upgrade: 'websocket' } },
      );
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({
      kind: 'participant',
      participantId: randomParticipantId(),
      joined: false,
    } satisfies ParticipantAttachment);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(socket: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const current = attachment(socket);
    if (!current) {
      socket.close(1008, 'Invalid participant attachment');
      return;
    }
    if (current.kind === 'helper') {
      if (typeof data !== 'string' || new TextEncoder().encode(data).byteLength > 4096) {
        socket.close(1008, 'Invalid helper message');
        return;
      }
      let helperRaw: unknown;
      try {
        helperRaw = JSON.parse(data);
      } catch {
        socket.close(1008, 'Invalid helper message');
        return;
      }
      const helperMessage = helperOutboundMessageSchema.safeParse(helperRaw);
      if (!helperMessage.success) {
        socket.close(1008, 'Invalid helper message');
        return;
      }
      // A helper may only talk to the participant that paired it, and only with safe control-plane state.
      if (helperMessage.data.type === 'helper-capabilities')
        this.sendToParticipant(current.ownerParticipantId, {
          type: 'helper-capabilities',
          payload: { availableScopes: helperMessage.data.availableScopes },
        });
      else if (helperMessage.data.type === 'helper-stop-control')
        this.sendToParticipant(current.ownerParticipantId, {
          type: 'helper-stop-control',
          payload: { controlSessionId: helperMessage.data.controlSessionId },
        });
      return;
    }
    const size =
      typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength;
    if (size > MAX_MESSAGE_BYTES || typeof data !== 'string') {
      sendProtocolError(socket, 'invalid_message', 'Message is too large or not valid JSON text.');
      socket.close(1009, 'Message too large');
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      sendProtocolError(socket, 'invalid_message', 'Message must contain valid JSON.');
      socket.close(1007, 'Invalid JSON');
      return;
    }
    const parsed = clientSignalingMessageSchema.safeParse(raw);
    if (!parsed.success) {
      sendProtocolError(socket, 'invalid_message', 'Message does not match the Duplex protocol.');
      socket.close(1008, 'Invalid message');
      return;
    }
    const message = parsed.data;

    if (!current.joined) {
      if (message.type !== 'join') {
        sendProtocolError(socket, 'not_joined', 'Join the room before sending messages.');
        socket.close(1008, 'Join required');
        return;
      }
      if (message.payload.protocolVersion !== PROTOCOL_VERSION) {
        sendProtocolError(
          socket,
          'protocol_mismatch',
          'Client and server protocol versions do not match.',
        );
        socket.close(4001, 'Protocol mismatch');
        return;
      }

      const joined = this.participants();
      if (joined.length >= MAX_ROOM_PARTICIPANTS) {
        send(
          socket,
          roomFullMessageSchema.parse({ type: 'room-full', payload: { reason: 'capacity' } }),
        );
        socket.close(4009, 'Room is full');
        return;
      }
      const peerPresent = joined.length > 0;
      const existingSocket = joined[0];
      const existingPeer = existingSocket ? attachment(existingSocket) : null;
      const updated = {
        ...current,
        joined: true,
        polite:
          peerPresent && existingPeer?.kind === 'participant'
            ? !(existingPeer.polite ?? false)
            : false,
        protocolVersion: PROTOCOL_VERSION,
        lastRtcConfigIssuedAt: Date.now(),
      };
      socket.serializeAttachment(updated);
      send(socket, {
        type: 'joined',
        payload: { participantId: updated.participantId, polite: updated.polite, peerPresent },
      });
      await this.sendRtcConfiguration(socket, updated.participantId);
      if (peerPresent) {
        for (const peer of joined) {
          const peerData = attachment(peer);
          if (peerData)
            send(peer, { type: 'peer-joined', payload: { participantId: updated.participantId } });
        }
      }
      return;
    }

    if (message.type === 'join') {
      sendProtocolError(socket, 'invalid_message', 'This participant has already joined.');
      socket.close(1008, 'Already joined');
      return;
    }
    if (message.type === 'leave') {
      this.notifyPeerLeft(socket);
      this.closeOwnerHelper(current.participantId);
      socket.serializeAttachment({
        ...current,
        joined: false,
        helperPairingTokenHash: undefined,
        helperPairingExpiresAt: undefined,
      });
      socket.close(1000, 'Participant left');
      return;
    }
    if (message.type === 'refresh-rtc-config') {
      const lastIssuedAt = current.lastRtcConfigIssuedAt ?? 0;
      if (Date.now() - lastIssuedAt < 60_000) return;
      const updated = { ...current, lastRtcConfigIssuedAt: Date.now() };
      socket.serializeAttachment(updated);
      await this.sendRtcConfiguration(socket, updated.participantId);
      return;
    }
    if (message.type === 'helper-pairing-create') {
      if (current.helperPaired) return;
      const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
      let binary = '';
      for (const byte of tokenBytes) binary += String.fromCharCode(byte);
      const token = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
      const hash = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
      const expiresAt = Date.now() + 2 * 60 * 1000;
      socket.serializeAttachment({
        ...current,
        helperPairingTokenHash: hash,
        helperPairingExpiresAt: expiresAt,
      });
      socket.send(
        JSON.stringify({ type: 'helper-pairing-created', payload: { token, expiresAt } }),
      );
      return;
    }
    if (message.type === 'helper-session-authorized' || message.type === 'helper-session-revoked') {
      if (!current.helperPaired) return;
      this.sendToOwnerHelper(current.participantId, message);
      return;
    }
    if (message.type === 'helper-input') {
      if (size > MAX_HELPER_INPUT_BYTES) {
        sendProtocolError(socket, 'invalid_message', 'Input message is too large.');
        socket.close(1009, 'Input too large');
        return;
      }
      // Never logged and never relayed to the peer browser: it only reaches this participant's helper.
      if (current.helperPaired) this.sendToOwnerHelper(current.participantId, message);
      return;
    }
    for (const peer of this.participants()) {
      if (peer !== socket) send(peer, message);
    }
  }

  private sendToOwnerHelper(
    ownerParticipantId: string,
    message: Extract<
      z.infer<typeof clientSignalingMessageSchema>,
      { type: 'helper-session-authorized' | 'helper-session-revoked' | 'helper-input' }
    >,
  ): void {
    const payload = JSON.stringify(message);
    for (const helperSocket of this.ctx.getWebSockets()) {
      const helper = attachment(helperSocket);
      if (
        helper?.kind === 'helper' &&
        helper.ownerParticipantId === ownerParticipantId &&
        helperSocket.readyState === WebSocket.OPEN
      )
        helperSocket.send(payload);
    }
  }

  private sendToParticipant(participantId: string, message: ServerSignalingMessage): void {
    for (const socket of this.participants()) {
      const value = attachment(socket);
      if (value?.kind === 'participant' && value.participantId === participantId)
        send(socket, message);
    }
  }

  private async sendRtcConfiguration(socket: WebSocket, participantId: string): Promise<void> {
    const config = await generateRtcConfiguration(this.env);
    const message = {
      type: 'rtc-config' as const,
      payload: {
        iceServers: config.iceServers,
        expiresAt: config.expiresAt,
        relayAvailable: config.relayAvailable,
      },
    };
    send(socket, message);
    if (!config.relayAvailable)
      console.warn('Participant received STUN-only configuration.', { participantId });
  }

  override webSocketClose(socket: WebSocket): void {
    this.notifyPeerLeft(socket);
    const current = attachment(socket);
    if (current?.kind === 'participant' && current.joined) {
      this.closeOwnerHelper(current.participantId);
      socket.serializeAttachment({
        ...current,
        joined: false,
        helperPairingTokenHash: undefined,
        helperPairingExpiresAt: undefined,
      });
    } else if (current?.kind === 'helper') this.helperClosed(current.ownerParticipantId);
  }

  override webSocketError(socket: WebSocket): void {
    this.notifyPeerLeft(socket);
    const current = attachment(socket);
    if (current?.kind === 'participant' && current.joined) {
      this.closeOwnerHelper(current.participantId);
      socket.serializeAttachment({
        ...current,
        joined: false,
        helperPairingTokenHash: undefined,
        helperPairingExpiresAt: undefined,
      });
    } else if (current?.kind === 'helper') this.helperClosed(current.ownerParticipantId);
    try {
      socket.close(1011, 'WebSocket error');
    } catch {
      /* Runtime may already have closed it. */
    }
  }

  private participants(): WebSocket[] {
    return this.ctx.getWebSockets().filter((socket) => {
      const value = attachment(socket);
      return value?.kind === 'participant' && value.joined;
    });
  }

  private notifyPeerLeft(socket: WebSocket): void {
    const current = attachment(socket);
    if (current?.kind !== 'participant' || !current.joined) return;
    for (const peer of this.participants()) {
      if (peer !== socket) send(peer, { type: 'peer-left', payload: {} });
    }
  }

  private async connectHelper(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
      return Response.json(
        { error: 'websocket_required' },
        { status: 426, headers: { Upgrade: 'websocket' } },
      );
    const authorization = request.headers.get('Authorization');
    const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
    if (!match) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(match[1]));
    const hash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    const owner = this.participants().find((socket) => {
      const value = attachment(socket);
      return value?.kind === 'participant' && value.helperPairingTokenHash === hash;
    });
    const ownerData = owner ? attachment(owner) : null;
    if (
      !owner ||
      ownerData?.kind !== 'participant' ||
      !ownerData.helperPairingExpiresAt ||
      ownerData.helperPairingExpiresAt <= Date.now()
    )
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    if (
      this.ctx.getWebSockets().some((socket) => {
        const value = attachment(socket);
        return value?.kind === 'helper' && value.ownerParticipantId === ownerData.participantId;
      })
    )
      return Response.json({ error: 'helper_already_connected' }, { status: 409 });
    owner.serializeAttachment({
      ...ownerData,
      helperPairingTokenHash: undefined,
      helperPairingExpiresAt: undefined,
      helperPaired: true,
    });
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({
      kind: 'helper',
      helperId: randomParticipantId(),
      ownerParticipantId: ownerData.participantId,
      pairedAt: Date.now(),
    } satisfies z.infer<typeof helperAttachmentSchema>);
    this.ctx.acceptWebSocket(server);
    if (owner.readyState === WebSocket.OPEN)
      owner.send(JSON.stringify({ type: 'helper-paired', payload: {} }));
    return new Response(null, { status: 101, webSocket: client });
  }

  private closeOwnerHelper(participantId: string): void {
    for (const socket of this.ctx.getWebSockets()) {
      const value = attachment(socket);
      if (value?.kind === 'helper' && value.ownerParticipantId === participantId)
        socket.close(1000, 'Owner left');
    }
  }

  private helperClosed(participantId: string): void {
    const owner = this.participants().find((socket) => {
      const value = attachment(socket);
      return value?.kind === 'participant' && value.participantId === participantId;
    });
    if (!owner) return;
    const value = attachment(owner);
    if (value?.kind === 'participant') owner.serializeAttachment({ ...value, helperPaired: false });
    if (owner.readyState === WebSocket.OPEN)
      owner.send(JSON.stringify({ type: 'helper-disconnected', payload: {} }));
  }
}
