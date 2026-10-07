import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  signal,
  viewChild,
  computed,
  input,
} from '@angular/core';
import type { ElementRef, OnDestroy } from '@angular/core';
import { RouterLink } from '@angular/router';
import { roomIdSchema } from '@duplex/protocol';
import { CallSessionService } from '../services/call-session.service';

@Component({
  selector: 'dx-room-page',
  imports: [RouterLink],
  providers: [CallSessionService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-h-dvh flex-col px-6 py-6 sm:px-10' },
  template: `
    <header class="flex items-center justify-between">
      <a
        routerLink="/"
        class="text-lg font-semibold tracking-tight focus-visible:outline-2 focus-visible:outline-offset-4"
        >Duplex</a
      >
      @if (isActive()) {
        <span class="text-sm text-zinc-600 dark:text-zinc-400">{{ statusText() }}</span>
      }
    </header>

    <main class="flex flex-1 flex-col items-center justify-center gap-6 py-8">
      <section
        class="relative flex min-h-[45vh] w-full max-w-6xl items-center justify-center overflow-hidden rounded-3xl border border-zinc-200 bg-zinc-100 p-3 dark:border-zinc-800 dark:bg-zinc-900 sm:min-h-[60vh]"
        [class.hidden]="
          !isActive() || (!session.remoteVideoStream() && !session.localVideoStream())
        "
        aria-label="Video call"
      >
        <video
          #remoteVideo
          autoplay
          playsinline
          [class.hidden]="!session.remoteVideoStream()"
          class="max-h-[70vh] w-full object-contain"
          aria-label="Peer video or shared screen"
        ></video>
        <div
          [class.hidden]="session.remoteVideoStream() || session.screenSharing()"
          class="flex min-h-64 items-center justify-center text-zinc-500"
        >
          Your preview
        </div>
        <video
          #localVideo
          autoplay
          muted
          playsinline
          [class.hidden]="!session.localVideoStream()"
          [class]="
            session.screenSharing() && !session.remoteVideoStream()
              ? 'max-h-[70vh] w-full object-contain'
              : 'absolute bottom-5 right-5 max-h-40 w-[min(28%,18rem)] rounded-2xl border border-white/70 bg-zinc-200 object-contain shadow-lg'
          "
          aria-label="Your camera or shared screen preview"
        ></video>
      </section>
      @if (!isValidRoom()) {
        <h1 class="text-3xl font-semibold tracking-tight sm:text-5xl">Invalid room link</h1>
        <p class="max-w-prose text-lg text-zinc-600 dark:text-zinc-400">
          This link is not a Duplex room.
        </p>
        <a routerLink="/" class="underline underline-offset-4">Start a new call</a>
      } @else if (session.state() === 'ready') {
        <h1 class="text-3xl font-semibold tracking-tight sm:text-5xl">Ready to join</h1>
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
      } @else if (session.state() === 'failed' || session.state() === 'left') {
        <h1 class="text-3xl font-semibold tracking-tight sm:text-5xl">
          {{ session.state() === 'left' ? 'You left the call' : 'Could not join the call' }}
        </h1>
        @if (session.sessionError()) {
          <p role="alert" class="max-w-prose text-zinc-600 dark:text-zinc-400">
            {{ session.sessionError() }}
          </p>
        }
        <div class="flex gap-3">
          <button
            type="button"
            class="rounded-full bg-zinc-900 px-5 py-2.5 text-white dark:bg-zinc-50 dark:text-zinc-900"
            (click)="join()"
          >
            {{ session.state() === 'left' ? 'Rejoin call' : 'Try again' }}
          </button>
          <a routerLink="/" class="rounded-full border border-zinc-300 px-5 py-2.5">Back</a>
        </div>
      } @else if (session.state() === 'requesting-media' || session.state() === 'joining') {
        <h1 class="text-3xl font-semibold tracking-tight">
          {{ session.state() === 'joining' ? 'Joining call…' : 'Allow microphone access' }}
        </h1>
        @if (session.sessionError()) {
          <p role="alert">{{ session.sessionError() }}</p>
        }
      } @else {
        @if (session.sessionError()) {
          <p role="alert" class="text-sm text-rose-700 dark:text-rose-300">
            {{ session.sessionError() }}
          </p>
        }
        <section
          class="flex min-h-[30vh] w-full max-w-4xl flex-col items-center justify-center gap-3 rounded-3xl border border-zinc-200 bg-zinc-50 px-6 text-center dark:border-zinc-800 dark:bg-zinc-900"
          [class.hidden]="session.remoteVideoStream() || session.localVideoStream()"
          aria-label="Audio call"
        >
          <h1 class="text-3xl font-semibold tracking-tight">
            {{ session.state() === 'connected' ? 'Connected' : statusText() }}
          </h1>
          <p class="text-zinc-600 dark:text-zinc-400">
            {{
              session.state() === 'connected'
                ? 'Audio call · Camera and screen are off.'
                : 'Share this link with the person you want to talk to.'
            }}
          </p>
        </section>

        @if (session.state() !== 'connected') {
          <div class="flex flex-wrap items-center justify-center gap-2">
            <label for="room-link" class="text-sm font-medium">Copy this link</label>
            <input
              id="room-link"
              class="w-[min(60vw,32rem)] rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm"
              readonly
              [value]="session.roomUrl()"
            />
            <button
              type="button"
              class="rounded-full border border-zinc-300 px-4 py-2 text-sm"
              (click)="copyLink()"
            >
              {{ copied() ? 'Copied' : 'Copy link' }}
            </button>
          </div>
        }

        <div class="flex flex-wrap justify-center gap-3" aria-label="Call controls">
          <button
            type="button"
            class="rounded-full border border-zinc-300 px-5 py-2.5"
            [attr.aria-pressed]="!session.muted()"
            (click)="session.toggleMute()"
          >
            {{ session.muted() ? 'Unmute' : 'Mute' }}
          </button>
          <button
            type="button"
            class="rounded-full border border-zinc-300 px-5 py-2.5"
            [attr.aria-pressed]="session.cameraEnabled()"
            (click)="session.toggleCamera()"
          >
            {{ session.cameraEnabled() ? 'Camera off' : 'Turn camera on' }}
          </button>
          <button
            type="button"
            class="rounded-full border border-zinc-300 px-5 py-2.5"
            [attr.aria-pressed]="session.screenSharing()"
            (click)="session.toggleScreenSharing()"
          >
            {{ session.screenSharing() ? 'Stop sharing' : 'Share screen' }}
          </button>
          <button
            type="button"
            class="rounded-full bg-zinc-900 px-5 py-2.5 text-white dark:bg-zinc-50 dark:text-zinc-900"
            (click)="leave()"
          >
            Leave
          </button>
        </div>
        @if (session.cameraError()) {
          <p role="alert" class="text-sm text-rose-700 dark:text-rose-300">
            {{ session.cameraError() }}
          </p>
        }
        @if (session.screenError()) {
          <p role="alert" class="text-sm text-rose-700 dark:text-rose-300">
            {{ session.screenError() }}
          </p>
        }
        @if (session.screenSharing()) {
          <p class="text-sm text-zinc-600 dark:text-zinc-400">
            Sharing screen. Your camera will resume when sharing stops.
          </p>
        }
      }
      <audio #remoteAudio autoplay></audio>
    </main>
  `,
})
export default class RoomPage implements OnDestroy {
  readonly roomId = input.required<string>();
  protected readonly session = inject(CallSessionService);
  protected readonly copied = signal(false);
  protected readonly isValidRoom = computed(() => roomIdSchema.safeParse(this.roomId()).success);
  protected readonly isActive = computed(() =>
    ['waiting-for-peer', 'connecting', 'connected', 'reconnecting'].includes(this.session.state()),
  );
  protected readonly statusText = computed(() => {
    switch (this.session.state()) {
      case 'waiting-for-peer':
        return 'Waiting for someone to join…';
      case 'connecting':
        return 'Connecting…';
      case 'reconnecting':
        return 'Connection interrupted. Reconnecting…';
      default:
        return 'Connected';
    }
  });

  private readonly remoteAudio = viewChild<ElementRef<HTMLAudioElement>>('remoteAudio');
  private readonly remoteVideo = viewChild<ElementRef<HTMLVideoElement>>('remoteVideo');
  private readonly localVideo = viewChild<ElementRef<HTMLVideoElement>>('localVideo');

  constructor() {
    effect(() => {
      const audio = this.remoteAudio()?.nativeElement;
      if (audio) {
        audio.srcObject = this.session.remoteAudioStream();
        if (audio.srcObject) void audio.play().catch(() => undefined);
      }
      const video = this.remoteVideo()?.nativeElement;
      if (video) {
        video.srcObject = this.session.remoteVideoStream();
        if (video.srcObject) void video.play().catch(() => undefined);
      }
      const local = this.localVideo()?.nativeElement;
      if (local) {
        local.srcObject = this.session.localVideoStream();
        if (local.srcObject) void local.play().catch(() => undefined);
      }
    });
  }

  protected join(): void {
    void this.session.join(this.roomId());
  }
  protected leave(): void {
    this.session.leave();
  }

  protected async copyLink(): Promise<void> {
    const text = this.session.copyLink();
    try {
      if (!window.isSecureContext) throw new Error('Clipboard requires a secure context.');
      await navigator.clipboard.writeText(text);
      this.copied.set(true);
      setTimeout(() => {
        this.copied.set(false);
      }, 2000);
    } catch {
      // The visible readonly URL remains selectable when clipboard access is unavailable.
    }
  }

  ngOnDestroy(): void {
    for (const ref of [this.remoteAudio(), this.remoteVideo(), this.localVideo()]) {
      if (ref) ref.nativeElement.srcObject = null;
    }
  }
}
