import { Injectable, signal } from '@angular/core';
import type { OnDestroy } from '@angular/core';
import { PROTOCOL_VERSION, roomIdSchema, serverSignalingMessageSchema } from '@duplex/protocol';
import type { RtcConfigMessage, ServerSignalingMessage, SignalingMessage } from '@duplex/protocol';
import { createDuplexPeer, toRtcIceServers } from '@duplex/webrtc';
import type { DuplexPeer, PeerSignalingMessage, SignalingTransport } from '@duplex/webrtc';
import { FileTransferService } from './file-transfer.service';

export type CallState =
  | 'ready'
  | 'requesting-media'
  | 'joining'
  | 'waiting-for-peer'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed'
  | 'left';

@Injectable()
export class CallSessionService implements OnDestroy {
  readonly state = signal<CallState>('ready');
  readonly sessionError = signal('');
  readonly cameraError = signal('');
  readonly screenError = signal('');
  readonly muted = signal(false);
  readonly cameraEnabled = signal(false);
  readonly screenSharing = signal(false);
  readonly localVideoStream = signal<MediaStream | null>(null);
  readonly remoteAudioStream = signal<MediaStream | null>(null);
  readonly remoteVideoStream = signal<MediaStream | null>(null);
  readonly roomUrl = signal('');
  readonly connectionPath = signal<'direct' | 'relay' | 'unknown'>('unknown');
  readonly fileChannelOpen = signal(false);
  readonly fileTransfers = new FileTransferService();

  private socket: WebSocket | null = null;
  private peer: DuplexPeer | null = null;
  private peerUnsubscribe: (() => void) | null = null;
  private dataChannelUnsubscribe: (() => void) | null = null;
  private callTransport: SignalingTransport | null = null;
  private transportListener: ((message: PeerSignalingMessage) => void) | null = null;
  private microphoneStream: MediaStream | null = null;
  private cameraTrack: MediaStreamTrack | null = null;
  private displayStream: MediaStream | null = null;
  private displayTrack: MediaStreamTrack | null = null;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private rtcRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private leaving = false;
  private lastJoined: Extract<ServerSignalingMessage, { type: 'joined' }>['payload'] | null = null;
  private rtcConfig: RtcConfigMessage['payload'] | null = null;
  private peerPresent = false;

  async join(roomId: string): Promise<void> {
    if (
      !roomIdSchema.safeParse(roomId).success ||
      this.state() === 'joining' ||
      this.state() === 'requesting-media'
    )
      return;
    this.cleanup(true);
    this.sessionError.set('');
    this.cameraError.set('');
    this.screenError.set('');
    this.leaving = false;
    this.lastJoined = null;
    this.rtcConfig = null;
    this.peerPresent = false;
    this.connectionPath.set('unknown');
    this.state.set('requesting-media');
    try {
      this.microphoneStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
    } catch {
      this.fail(
        'Microphone permission was denied or no microphone is available. Check browser permissions and try again.',
      );
      return;
    }

    this.state.set('joining');
    try {
      const apiOrigin = import.meta.env.VITE_DUPLEX_API_ORIGIN?.replace(/\/+$/, '');
      const apiUrl = apiOrigin ? new URL(apiOrigin) : null;
      const scheme = apiUrl
        ? apiUrl.protocol === 'https:'
          ? 'wss:'
          : 'ws:'
        : location.protocol === 'https:'
          ? 'wss:'
          : 'ws:';
      const host = apiUrl ? apiUrl.host : location.host;
      this.roomUrl.set(location.href);
      const socket = new WebSocket(`${scheme}//${host}/api/rooms/${encodeURIComponent(roomId)}/ws`);
      this.socket = socket;
      socket.onopen = () => {
        const joinMessage: SignalingMessage = {
          type: 'join',
          payload: { roomId, protocolVersion: PROTOCOL_VERSION },
        };
        socket.send(JSON.stringify(joinMessage));
      };
      socket.onmessage = (event: MessageEvent<unknown>) => {
        this.onServerMessage(event.data);
      };
      socket.onerror = () => {
        this.fail('The room connection failed. Check your connection and try again.');
      };
      socket.onclose = (event) => {
        if (this.leaving || this.state() === 'failed' || this.state() === 'left') return;
        if (event.code === 4001)
          this.fail(
            'This Duplex version is not compatible with the room server. Reload the page to update.',
          );
        else if (event.code !== 1000) this.fail('The room connection closed. Try joining again.');
      };
      this.timeoutId = setTimeout(() => {
        if (this.state() === 'joining')
          this.fail('The room did not respond. Check your connection and try again.');
      }, 10000);
    } catch {
      this.fail('Could not open the room connection. Try again.');
    }
  }

  toggleMute(): void {
    const nextMuted = !this.muted();
    for (const track of this.microphoneStream?.getAudioTracks() ?? []) track.enabled = !nextMuted;
    this.muted.set(nextMuted);
  }

  async toggleCamera(): Promise<void> {
    this.cameraError.set('');
    if (this.cameraEnabled()) {
      this.cameraEnabled.set(false);
      try {
        if (!this.screenSharing()) await this.replaceOutgoingVideo(null);
      } catch {
        this.cameraError.set(
          'Could not update the other participant’s video. The call is still active.',
        );
      }
      this.stopTrack(this.cameraTrack);
      this.cameraTrack = null;
      this.updateLocalVideo();
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true });
    } catch {
      this.cameraError.set('Camera access was unavailable. Your audio call can continue.');
      return;
    }
    const track = stream.getVideoTracks()[0];
    if (!track) {
      this.cameraError.set('No camera was available. Your audio call can continue.');
      return;
    }
    this.cameraTrack = track;
    this.cameraEnabled.set(true);
    this.updateLocalVideo();
    try {
      if (!this.screenSharing()) await this.replaceOutgoingVideo(track);
    } catch {
      this.cameraError.set(
        'Camera is on locally, but its video could not be sent. The call is still active.',
      );
    }
  }

  async toggleScreenSharing(): Promise<void> {
    if (this.screenSharing()) {
      await this.stopScreenSharing();
      return;
    }
    this.screenError.set('');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch {
      // Cancelling the browser picker is a normal outcome and must not interrupt the call.
      return;
    }
    const track = stream.getVideoTracks()[0];
    if (!track) {
      for (const captureTrack of stream.getTracks()) this.stopTrack(captureTrack);
      this.screenError.set('No screen or window was available to share.');
      return;
    }
    this.displayStream = stream;
    this.displayTrack = track;
    track.onended = () => {
      void this.stopScreenSharing();
    };
    this.screenSharing.set(true);
    this.updateLocalVideo();
    try {
      await this.replaceOutgoingVideo(track);
    } catch {
      await this.stopScreenSharing();
      this.screenError.set(
        'Screen capture started, but its video could not be sent. The call is still active.',
      );
    }
  }

  async stopScreenSharing(): Promise<void> {
    if (!this.screenSharing() && !this.displayTrack) return;
    const track = this.displayTrack;
    this.displayTrack = null;
    this.displayStream = null;
    this.screenSharing.set(false);
    if (track) track.onended = null;
    this.stopTrack(track);
    this.updateLocalVideo();
    try {
      await this.replaceOutgoingVideo(this.cameraEnabled() ? this.cameraTrack : null);
    } catch {
      this.screenError.set(
        'Could not update the other participant’s video. The call is still active.',
      );
    }
  }

  copyLink(): string {
    return this.roomUrl();
  }

  leave(): void {
    this.leaving = true;
    this.socket?.send(JSON.stringify({ type: 'leave', payload: {} } satisfies SignalingMessage));
    this.cleanup(true);
    this.state.set('left');
    this.sessionError.set('');
  }

  ngOnDestroy(): void {
    this.leaving = true;
    this.cleanup(true);
  }

  private onServerMessage(data: unknown): void {
    let raw: unknown;
    try {
      raw = typeof data === 'string' ? JSON.parse(data) : data;
    } catch {
      this.fail('The room sent an invalid message.');
      return;
    }
    const result = serverSignalingMessageSchema.safeParse(raw);
    if (!result.success) {
      this.fail('The room sent an unsupported message. Reload and try again.');
      return;
    }
    const message = result.data;
    if (message.type === 'joined') {
      this.lastJoined = message.payload;
      this.peerPresent = message.payload.peerPresent;
      if (this.timeoutId) clearTimeout(this.timeoutId);
      this.timeoutId = null;
      this.makeTransport();
      if (!message.payload.peerPresent) this.state.set('waiting-for-peer');
    } else if (message.type === 'peer-joined') {
      this.peerPresent = true;
      if (this.lastJoined) this.startPeer(this.lastJoined.polite);
    } else if (message.type === 'peer-left') {
      this.closePeer();
      if (this.microphoneStream) this.state.set('waiting-for-peer');
    } else if (message.type === 'room-full') {
      this.fail('This room already has two participants. Ask them to share a new link.');
      this.socket?.close(4009, 'Room is full');
    } else if (message.type === 'protocol-error') {
      this.fail(
        message.payload.code === 'protocol_mismatch'
          ? 'This Duplex version is not compatible with the room server. Reload the page to update.'
          : message.payload.message,
      );
    } else if (message.type === 'rtc-config') {
      this.applyRtcConfiguration(message);
    } else {
      this.transportListener?.(message);
    }
  }

  private makeTransport(): void {
    const listeners = new Set<(message: PeerSignalingMessage) => void>();
    this.callTransport = {
      send: (message) => {
        if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    this.transportListener = (message) => {
      for (const listener of listeners) listener(message);
    };
  }

  private startPeer(polite: boolean): void {
    if (
      !this.microphoneStream ||
      !this.callTransport ||
      !this.rtcConfig ||
      !this.peerPresent ||
      this.peer
    )
      return;
    this.peer = createDuplexPeer(this.callTransport, {
      polite,
      localStream: this.microphoneStream,
      iceServers: toRtcIceServers(this.rtcConfig.iceServers),
      ...(import.meta.env.DEV && import.meta.env.VITE_DUPLEX_FORCE_RELAY === 'true'
        ? { iceTransportPolicy: 'relay' as const }
        : {}),
    });
    this.peerUnsubscribe = this.peer.subscribe((event) => {
      if (event.type === 'connection-state') {
        if (event.state === 'connected') this.state.set('connected');
        else if (event.state === 'reconnecting') this.state.set('reconnecting');
        else if (event.state === 'failed')
          this.fail(
            this.rtcConfig?.relayAvailable
              ? 'The peer connection could not recover. Leave and try again.'
              : 'The direct connection failed and TURN relay is unavailable. Check TURN configuration or try another network.',
          );
        else if (event.state === 'connecting') this.state.set('connecting');
      } else if (event.type === 'connection-path') {
        this.connectionPath.set(event.path);
      } else if (event.type === 'remote-media') {
        this.remoteAudioStream.set(event.media.audio);
        this.remoteVideoStream.set(event.media.video);
      } else if (event.type === 'data-channel') {
        this.fileTransfers.attachChannel(event.channel);
        this.dataChannelUnsubscribe?.();
        this.dataChannelUnsubscribe = event.channel.subscribe((channelEvent) => {
          if (channelEvent.type === 'open') this.fileChannelOpen.set(true);
          else if (channelEvent.type === 'close') this.fileChannelOpen.set(false);
        });
        this.fileChannelOpen.set(event.channel.state === 'open');
      } else {
        this.fileChannelOpen.set(true);
      }
    });
    const activeTrack = this.screenSharing()
      ? this.displayTrack
      : this.cameraEnabled()
        ? this.cameraTrack
        : null;
    if (activeTrack) void this.replaceOutgoingVideo(activeTrack);
    this.state.set('connecting');
  }

  private applyRtcConfiguration(message: RtcConfigMessage): void {
    this.rtcConfig = message.payload;
    this.peer?.updateIceServers(toRtcIceServers(message.payload.iceServers));
    if (this.rtcRefreshTimer) clearTimeout(this.rtcRefreshTimer);
    this.rtcRefreshTimer = null;
    if (message.payload.relayAvailable) {
      const refreshDelay = Math.max(1000, message.payload.expiresAt - Date.now() - 60 * 60 * 1000);
      this.rtcRefreshTimer = setTimeout(() => {
        this.rtcRefreshTimer = null;
        if (this.socket?.readyState === WebSocket.OPEN)
          this.socket.send(
            JSON.stringify({ type: 'refresh-rtc-config', payload: {} } satisfies SignalingMessage),
          );
      }, refreshDelay);
    }
    if (this.peerPresent && this.lastJoined) this.startPeer(this.lastJoined.polite);
  }

  private async replaceOutgoingVideo(track: MediaStreamTrack | null): Promise<void> {
    if (this.peer) await this.peer.setVideoTrack(track);
  }

  private updateLocalVideo(): void {
    this.localVideoStream.set(
      this.screenSharing()
        ? this.displayStream
        : this.cameraEnabled()
          ? this.cameraTrack?.kind === 'video'
            ? new MediaStream([this.cameraTrack])
            : null
          : null,
    );
  }

  private closePeer(): void {
    this.dataChannelUnsubscribe?.();
    this.dataChannelUnsubscribe = null;
    this.fileChannelOpen.set(false);
    this.fileTransfers.peerChanged();
    this.peerUnsubscribe?.();
    this.peerUnsubscribe = null;
    this.peer?.close();
    this.peer = null;
    this.remoteAudioStream.set(null);
    this.remoteVideoStream.set(null);
    this.connectionPath.set('unknown');
  }

  private fail(message: string): void {
    this.sessionError.set(message);
    this.state.set('failed');
    this.leaving = true;
    this.cleanup(true);
  }

  private cleanup(stopMedia: boolean): void {
    if (this.timeoutId) clearTimeout(this.timeoutId);
    this.timeoutId = null;
    if (this.rtcRefreshTimer) clearTimeout(this.rtcRefreshTimer);
    this.rtcRefreshTimer = null;
    this.closePeer();
    this.fileTransfers.destroy();
    this.transportListener = null;
    this.callTransport = null;
    if (this.socket) {
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onerror = null;
      this.socket.onclose = null;
      if (this.socket.readyState < WebSocket.CLOSING) this.socket.close(1000, 'Call closed');
      this.socket = null;
    }
    if (stopMedia) {
      for (const track of this.microphoneStream?.getTracks() ?? []) this.stopTrack(track);
      this.microphoneStream = null;
      this.stopTrack(this.cameraTrack);
      this.stopTrack(this.displayTrack);
      this.cameraTrack = null;
      this.displayTrack = null;
      this.displayStream = null;
      this.localVideoStream.set(null);
      this.cameraEnabled.set(false);
      this.screenSharing.set(false);
      this.muted.set(false);
    }
  }

  private stopTrack(track: MediaStreamTrack | null): void {
    if (track) {
      track.onended = null;
      track.stop();
    }
  }
}
