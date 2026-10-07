import {
  ChangeDetectionStrategy,
  Component,
  ViewChild,
  computed,
  input,
  signal,
} from '@angular/core';
import type { ElementRef, OnDestroy } from '@angular/core';
import { RouterLink } from '@angular/router';
import { PROTOCOL_VERSION, roomIdSchema, serverSignalingMessageSchema } from '@duplex/protocol';
import type { ServerSignalingMessage, SignalingMessage } from '@duplex/protocol';
import { createDuplexPeer } from '@duplex/webrtc';
import type { DuplexPeer, PeerSignalingMessage, SignalingTransport } from '@duplex/webrtc';

type CallState =
  | 'ready'
  | 'requesting-media'
  | 'joining'
  | 'waiting-for-peer'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed'
  | 'left';

@Component({
  selector: 'dx-room-page',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-h-dvh flex-col px-6 py-8 sm:px-10' },
  template: `
    <header>
      <a
        routerLink="/"
        class="text-lg font-semibold tracking-tight focus-visible:outline-2 focus-visible:outline-offset-4"
        >Duplex</a
      >
    </header>

    <main class="flex flex-1 flex-col items-start justify-center gap-5 pb-16">
      @if (!isValidRoom()) {
        <h1 class="text-3xl font-semibold tracking-tight sm:text-5xl">Invalid room link</h1>
        <p class="max-w-prose text-lg text-zinc-600 dark:text-zinc-400">
          This link is not a Duplex room.
        </p>
        <a routerLink="/" class="underline underline-offset-4">Start a new call</a>
      } @else {
        <h1 class="text-3xl font-semibold tracking-tight sm:text-5xl">{{ heading() }}</h1>
        @if (error()) {
          <p role="alert" class="max-w-prose text-zinc-600 dark:text-zinc-400">{{ error() }}</p>
        }
        @if (state() === 'ready') {
          <p class="text-lg text-zinc-600 dark:text-zinc-400">
            Your microphone will turn on when you join.
          </p>
          <button
            type="button"
            class="rounded-full bg-zinc-900 px-7 py-3.5 font-medium text-zinc-50 dark:bg-zinc-50 dark:text-zinc-900"
            (click)="join()"
          >
            Join call
          </button>
        } @else if (
          state() === 'waiting-for-peer' ||
          state() === 'connected' ||
          state() === 'connecting' ||
          state() === 'reconnecting'
        ) {
          <p class="text-zinc-600 dark:text-zinc-400">{{ statusText() }}</p>
          @if (state() !== 'connected') {
            <div class="flex flex-col gap-2">
              <label for="room-link" class="text-sm font-medium">Copy this link</label>
              <div class="flex items-center gap-2">
                <input
                  id="room-link"
                  class="w-[min(70vw,32rem)] rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm"
                  readonly
                  [value]="currentUrl()"
                />
                <button
                  type="button"
                  class="rounded-full border border-zinc-300 px-4 py-2 text-sm"
                  (click)="copyLink()"
                >
                  {{ copied() ? 'Copied' : 'Copy link' }}
                </button>
              </div>
            </div>
          }
          @if (state() === 'connected') {
            <p class="text-sm text-zinc-600 dark:text-zinc-400">● You &nbsp; ● Peer</p>
            <div class="flex gap-3">
              <button
                type="button"
                class="rounded-full border border-zinc-300 px-5 py-2.5"
                (click)="toggleMute()"
              >
                {{ muted() ? 'Unmute' : 'Mute' }}
              </button>
              <button
                type="button"
                class="rounded-full bg-zinc-900 px-5 py-2.5 text-white dark:bg-zinc-50 dark:text-zinc-900"
                (click)="leave()"
              >
                Leave
              </button>
            </div>
          }
          @if (state() === 'waiting-for-peer') {
            <button
              type="button"
              class="rounded-full border border-zinc-300 px-5 py-2.5"
              (click)="leave()"
            >
              Leave
            </button>
          }
        } @else if (state() === 'failed' || state() === 'left') {
          <div class="flex gap-3">
            <button
              type="button"
              class="rounded-full bg-zinc-900 px-5 py-2.5 text-white dark:bg-zinc-50 dark:text-zinc-900"
              (click)="reset()"
            >
              {{ state() === 'left' ? 'Rejoin call' : 'Try again' }}
            </button>
            <a routerLink="/" class="rounded-full border border-zinc-300 px-5 py-2.5">Back</a>
          </div>
        } @else {
          <p class="text-zinc-600 dark:text-zinc-400">{{ statusText() }}</p>
        }
      }
      <audio #remoteAudio autoplay></audio>
    </main>
  `,
})
export default class RoomPage implements OnDestroy {
  readonly roomId = input.required<string>();
  protected readonly state = signal<CallState>('ready');
  protected readonly error = signal('');
  protected readonly muted = signal(false);
  protected readonly copied = signal(false);
  protected readonly currentUrl = signal('');
  protected readonly isValidRoom = computed(() => roomIdSchema.safeParse(this.roomId()).success);
  protected readonly heading = computed(() => {
    switch (this.state()) {
      case 'ready':
        return 'Ready to join';
      case 'requesting-media':
        return 'Allow microphone access';
      case 'joining':
        return 'Joining call…';
      case 'waiting-for-peer':
        return 'Waiting for someone to join…';
      case 'connected':
        return 'Connected';
      case 'connecting':
        return 'Connecting…';
      case 'reconnecting':
        return 'Reconnecting…';
      case 'failed':
        return 'Could not join the call';
      case 'left':
        return 'You left the call';
    }
  });
  protected readonly statusText = computed(() =>
    this.state() === 'waiting-for-peer'
      ? 'Share this link with the person you want to talk to.'
      : this.state() === 'connecting'
        ? 'Setting up a direct audio connection…'
        : this.state() === 'reconnecting'
          ? 'The audio connection was interrupted.'
          : 'Your call is active.',
  );

  @ViewChild('remoteAudio') private remoteAudio?: ElementRef<HTMLAudioElement>;
  private socket: WebSocket | null = null;
  private peer: DuplexPeer | null = null;
  private localStream: MediaStream | null = null;
  private peerUnsubscribe: (() => void) | null = null;
  private callTransport: SignalingTransport | null = null;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private leaving = false;

  async join(): Promise<void> {
    if (!this.isValidRoom() || this.state() === 'joining' || this.state() === 'requesting-media')
      return;
    this.clearResources(false);
    this.error.set('');
    this.leaving = false;
    this.state.set('requesting-media');
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch {
      this.fail(
        'Microphone permission was denied or no microphone is available. Check browser permissions and try again.',
      );
      return;
    }

    this.state.set('joining');
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${scheme}//${location.host}/api/rooms/${encodeURIComponent(this.roomId())}/ws`;
    try {
      const socket = new WebSocket(url);
      this.socket = socket;
      this.currentUrl.set(location.href);
      socket.onopen = () => {
        const joinMessage: SignalingMessage = {
          type: 'join',
          payload: { roomId: this.roomId(), protocolVersion: PROTOCOL_VERSION },
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

  protected toggleMute(): void {
    const nextMuted = !this.muted();
    for (const track of this.localStream?.getAudioTracks() ?? []) track.enabled = !nextMuted;
    this.muted.set(nextMuted);
  }

  protected async copyLink(): Promise<void> {
    const text = location.href;
    try {
      if (!window.isSecureContext) throw new Error('Clipboard requires a secure context.');
      await navigator.clipboard.writeText(text);
      this.copied.set(true);
      setTimeout(() => {
        this.copied.set(false);
      }, 2000);
    } catch {
      this.error.set('Copy is unavailable here. Select and copy the room link above.');
    }
  }

  protected leave(): void {
    this.leaving = true;
    this.socket?.send(JSON.stringify({ type: 'leave', payload: {} } satisfies SignalingMessage));
    this.clearResources(true);
    this.state.set('left');
    this.error.set('');
  }

  protected reset(): void {
    void this.join();
  }

  ngOnDestroy(): void {
    this.leaving = true;
    this.clearResources(true);
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
      if (this.timeoutId) clearTimeout(this.timeoutId);
      this.makeTransport();
      if (message.payload.peerPresent) this.startPeer(message.payload.polite);
      else this.state.set('waiting-for-peer');
    } else if (message.type === 'peer-joined') {
      const joined = this.lastJoined;
      if (joined) this.startPeer(joined.polite);
    } else if (message.type === 'peer-left') {
      this.closePeer();
      if (this.localStream) this.state.set('waiting-for-peer');
    } else if (message.type === 'room-full') {
      this.fail('This room already has two participants. Ask them to share a new link.');
      this.socket?.close(4009, 'Room is full');
    } else if (message.type === 'protocol-error') {
      this.fail(
        message.payload.code === 'protocol_mismatch'
          ? 'This Duplex version is not compatible with the room server. Reload the page to update.'
          : message.payload.message,
      );
    } else if (this.transportListener) {
      this.transportListener(message);
    }
  }

  private lastJoined: Extract<ServerSignalingMessage, { type: 'joined' }>['payload'] | null = null;
  private transportListener: ((message: PeerSignalingMessage) => void) | null = null;

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
    if (!this.localStream || !this.callTransport || this.peer) return;
    this.peer = createDuplexPeer(this.callTransport, { polite, localStream: this.localStream });
    this.peerUnsubscribe = this.peer.subscribe((event) => {
      if (event.type === 'connection-state') {
        if (event.state === 'connected') this.state.set('connected');
        else if (event.state === 'reconnecting') this.state.set('reconnecting');
        else if (event.state === 'failed')
          this.fail('The direct audio connection failed. Leave and try again.');
        else if (event.state === 'connecting') this.state.set('connecting');
      } else if (event.type === 'remote-media' && this.remoteAudio) {
        const audio = event.media.audio;
        this.remoteAudio.nativeElement.srcObject = audio;
        void this.remoteAudio.nativeElement.play().catch(() => {
          this.error.set('Tap the page to allow remote audio playback.');
        });
      }
    });
    this.state.set('connecting');
  }

  private closePeer(): void {
    this.peerUnsubscribe?.();
    this.peerUnsubscribe = null;
    this.peer?.close();
    this.peer = null;
    if (this.remoteAudio) this.remoteAudio.nativeElement.srcObject = null;
  }

  private fail(message: string): void {
    this.error.set(message);
    this.state.set('failed');
    this.leaving = true;
    this.clearResources(true);
  }

  private clearResources(stopMedia: boolean): void {
    if (this.timeoutId) clearTimeout(this.timeoutId);
    this.timeoutId = null;
    this.closePeer();
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
      for (const track of this.localStream?.getTracks() ?? []) track.stop();
      this.localStream = null;
      this.muted.set(false);
    }
  }
}
