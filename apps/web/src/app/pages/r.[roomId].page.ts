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
import { clientToNormalized, containedVideoRect } from '../collaboration/screen-geometry';
import type { NormalizedPoint } from '../services/collaboration.service';
import { normalizeWheelDelta } from '../services/remote-input.service';

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
        <div class="flex items-center gap-3">
          @if (showConnectionPath) {
            <span class="text-xs text-zinc-500 dark:text-zinc-500">
              {{ session.connectionPath() }} path
            </span>
          }
          <span class="text-sm text-zinc-600 dark:text-zinc-400">{{ statusText() }}</span>
        </div>
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
        <div
          #videoSurface
          class="relative flex min-h-[40vh] w-full items-center justify-center sm:min-h-[55vh]"
        >
          <video
            #remoteVideo
            autoplay
            playsinline
            [class]="
              !session.remoteVideoStream()
                ? 'hidden'
                : session.collaboration.peerVideoSource() === 'screen' ||
                    session.collaboration.localVideoSource() !== 'screen'
                  ? 'max-h-[70vh] w-full object-contain'
                  : 'absolute bottom-3 right-3 max-h-40 w-[min(28%,18rem)] rounded-2xl border border-white/70 bg-zinc-200 object-contain shadow-lg'
            "
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
            [class]="
              !session.localVideoStream()
                ? 'hidden'
                : session.collaboration.localVideoSource() === 'screen' &&
                    session.collaboration.peerVideoSource() !== 'screen'
                  ? 'max-h-[70vh] w-full object-contain'
                  : 'absolute bottom-3 right-3 max-h-40 w-[min(28%,18rem)] rounded-2xl border border-white/70 bg-zinc-200 object-contain shadow-lg'
            "
            aria-label="Your camera or shared screen preview"
          ></video>
          @if (session.collaboration.surfaceActive()) {
            <svg
              class="absolute inset-0 h-full w-full touch-none"
              [attr.viewBox]="overlayViewBox()"
              preserveAspectRatio="none"
              role="img"
              aria-label="Shared screen collaboration surface"
              (pointerdown)="onSurfacePointerDown($event)"
              (pointermove)="onSurfacePointerMove($event)"
              (pointerup)="onSurfacePointerUp($event)"
              (pointercancel)="onSurfacePointerUp($event)"
              (lostpointercapture)="onSurfacePointerUp($event)"
              (pointerleave)="onSurfacePointerLeave()"
              (contextmenu)="onSurfaceContextMenu($event)"
              (wheel)="onSurfaceWheel($event)"
              [class.cursor-crosshair]="session.remoteInput.capturing()"
            >
              <g [attr.transform]="overlayTransform()">
                @for (stroke of session.collaboration.strokes(); track stroke.id) {
                  <path
                    [attr.d]="strokePath(stroke.points)"
                    fill="none"
                    stroke="#2563eb"
                    stroke-width="0.004"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    vector-effect="non-scaling-stroke"
                    class="pointer-events-none"
                  />
                }
                @if (session.collaboration.remotePointer(); as pointer) {
                  <circle
                    [attr.cx]="pointer.x"
                    [attr.cy]="pointer.y"
                    [attr.r]="pointer.mode === 'laser' ? 0.012 : 0.009"
                    [attr.fill]="pointer.mode === 'laser' ? '#ef4444' : '#2563eb'"
                    class="pointer-events-none"
                    [class.animate-pulse]="pointer.mode === 'laser'"
                  />
                }
              </g>
            </svg>
          }
        </div>
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
          @if (session.fileChannelOpen()) {
            <button
              type="button"
              class="rounded-full border border-zinc-300 px-5 py-2.5"
              (click)="openFilePicker()"
            >
              Send file
            </button>
            <input
              #filePicker
              class="hidden"
              type="file"
              multiple
              aria-label="Choose files to send"
              (change)="selectFiles($event)"
            />
          }
          <button
            type="button"
            class="rounded-full bg-zinc-900 px-5 py-2.5 text-white dark:bg-zinc-50 dark:text-zinc-900"
            (click)="leave()"
          >
            Leave
          </button>
        </div>
        @if (session.collaboration.surfaceActive()) {
          <div class="flex flex-wrap justify-center gap-2" aria-label="Screen collaboration tools">
            @for (tool of collaborationTools; track tool.id) {
              <button
                type="button"
                class="rounded-full border border-zinc-300 px-4 py-2 text-sm disabled:opacity-50"
                [attr.aria-pressed]="session.collaboration.tool() === tool.id"
                [disabled]="
                  tool.disabled ||
                  session.remoteInput.capturing() ||
                  ((tool.id === 'pointer' || tool.id === 'laser') &&
                    !session.collaboration.pointerChannelOpen()) ||
                  (tool.id === 'draw' && !session.collaboration.collaborationChannelOpen())
                "
                (click)="session.collaboration.setTool(tool.id)"
              >
                {{ tool.label }}
              </button>
            }
            <button
              type="button"
              class="rounded-full border border-zinc-300 px-4 py-2 text-sm disabled:opacity-50"
              [disabled]="!session.collaboration.collaborationChannelOpen()"
              (click)="session.collaboration.clearAnnotations()"
            >
              Clear
            </button>
          </div>
        }
        @if (session.screenSharing()) {
          <section
            class="w-full max-w-2xl rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800"
            aria-label="Duplex Helper"
          >
            <h2 class="font-medium">Duplex Helper</h2>
            @if (session.helperConnected()) {
              <p role="status" class="mt-2 text-sm text-emerald-700 dark:text-emerald-300">
                Helper connected
              </p>
              @if (session.control.localAvailableScopes().includes('pointer')) {
                <p class="mt-1 text-sm">Pointer control is ready. Keyboard is not available yet.</p>
              } @else {
                <p class="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                  Pointer control is not ready. Share an entire screen, then enable Accessibility
                  and choose a display in Duplex Helper (macOS only).
                </p>
              }
            } @else if (session.helperPairingCode()) {
              <p class="mt-2 text-sm">Pairing code ready. It expires in 2 minutes.</p>
              <textarea
                class="mt-2 w-full rounded-lg border bg-transparent p-2 font-mono text-xs"
                readonly
                aria-label="Helper pairing code"
                [value]="session.helperPairingCode()"
              ></textarea>
              <button
                type="button"
                class="mt-2 rounded-full border px-4 py-2"
                (click)="copyHelperCode()"
              >
                {{ helperCopied() ? 'Copied' : 'Copy helper code' }}
              </button>
            } @else {
              <p class="mt-2 text-sm text-zinc-600 dark:text-zinc-400">Not connected</p>
              <button
                type="button"
                class="mt-2 rounded-full border px-4 py-2"
                (click)="session.createHelperPairingCode()"
              >
                Create pairing code
              </button>
            }
          </section>
        }
        @if (session.collaboration.peerVideoSource() === 'screen' || session.screenSharing()) {
          <section
            class="w-full max-w-2xl rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800"
            aria-label="Assist control"
          >
            @if (session.control.session(); as controlSession) {
              <p role="status" class="font-medium">
                {{
                  controlSession.role === 'controller'
                    ? 'Control granted'
                    : 'Peer has control permission'
                }}
              </p>
              <p class="mt-1 text-sm">
                {{ controlSession.scopes.join(' · ') }} · Expires in
                {{ session.control.remainingSeconds() }} seconds
              </p>
              <p class="mt-1 text-xs text-zinc-500">
                {{
                  controlSession.role === 'controller'
                    ? 'Pointer control is live: move, click, drag and scroll over the shared screen.'
                    : 'Your peer can move and click your mouse. Keyboard control is not available.'
                }}
              </p>
              <button
                type="button"
                class="mt-2 rounded-full border px-4 py-2"
                (click)="session.control.release()"
              >
                {{ controlSession.role === 'controller' ? 'Release control' : 'Stop control' }}
              </button>
            } @else if (session.control.incomingRequest(); as request) {
              <div role="alertdialog" aria-label="Control permission request">
                <p class="font-medium">Peer wants to control this screen</p>
                <p class="mt-1 text-sm">Requested: {{ request.scopes.join(' · ') }}</p>
                <p class="mt-1 text-sm">Access expires automatically.</p>
                <div class="mt-3 flex gap-2">
                  <button
                    type="button"
                    class="rounded-full border px-4 py-2"
                    (click)="session.control.reject()"
                  >
                    Reject
                  </button>
                  <button
                    type="button"
                    class="rounded-full bg-zinc-900 px-4 py-2 text-white dark:bg-zinc-50 dark:text-zinc-900"
                    (click)="session.control.allow()"
                  >
                    Allow
                  </button>
                </div>
              </div>
            } @else if (session.control.canRequest()) {
              <p class="font-medium">Assist is available for this shared screen.</p>
              <p class="mt-1 text-sm">Pointer ✓ · Keyboard — not available yet</p>
              <button
                type="button"
                class="mt-2 rounded-full border px-4 py-2 disabled:opacity-50"
                [disabled]="session.control.state() === 'requesting'"
                (click)="session.control.requestControl()"
              >
                {{ session.control.state() === 'requesting' ? 'Request sent' : 'Request control' }}
              </button>
            } @else {
              <p class="text-sm">
                Remote control unavailable until the screen sharer pairs Duplex Helper.
              </p>
            }
          </section>
        }
        @if (session.fileTransfers.transfers().length) {
          <section class="w-full max-w-2xl space-y-3" aria-label="File transfers">
            @for (transfer of session.fileTransfers.transfers(); track transfer.id) {
              <article class="rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800">
                <div class="flex items-start justify-between gap-4">
                  <div class="min-w-0">
                    <p class="font-medium">
                      {{ transfer.direction === 'sending' ? 'Sending' : 'Peer wants to send' }}
                    </p>
                    <p class="truncate text-sm text-zinc-600 dark:text-zinc-400">
                      {{ transfer.name }} · {{ formatSize(transfer.size) }}
                    </p>
                  </div>
                  @if (transfer.state === 'offered') {
                    <div class="flex gap-2">
                      <button
                        type="button"
                        class="rounded-full border px-4 py-2 text-sm"
                        (click)="declineFile(transfer.id)"
                      >
                        Decline
                      </button>
                      <button
                        type="button"
                        class="rounded-full bg-zinc-900 px-4 py-2 text-sm text-white dark:bg-zinc-50 dark:text-zinc-900"
                        (click)="acceptFile(transfer.id)"
                      >
                        Accept
                      </button>
                    </div>
                  } @else if (transfer.state === 'transferring') {
                    <button
                      type="button"
                      class="rounded-full border px-4 py-2 text-sm"
                      (click)="cancelFile(transfer.id)"
                    >
                      Cancel
                    </button>
                  } @else if (
                    transfer.state === 'completed' && transfer.direction === 'receiving'
                  ) {
                    <div class="flex gap-2">
                      <a
                        class="rounded-full bg-zinc-900 px-4 py-2 text-sm text-white dark:bg-zinc-50 dark:text-zinc-900"
                        [href]="downloadUrl(transfer.id)"
                        [attr.download]="transfer.name"
                        >Download</a
                      >
                      <button
                        type="button"
                        class="rounded-full border px-3 py-1 text-sm"
                        (click)="dismissTransfer(transfer.id)"
                        aria-label="Dismiss transfer"
                      >
                        Dismiss
                      </button>
                    </div>
                  } @else if (
                    transfer.state !== 'queued' && transfer.state !== 'waiting-for-acceptance'
                  ) {
                    <button
                      type="button"
                      class="rounded-full border px-3 py-1 text-sm"
                      (click)="dismissTransfer(transfer.id)"
                      aria-label="Dismiss transfer"
                    >
                      Dismiss
                    </button>
                  }
                </div>
                @if (transfer.state === 'transferring') {
                  <progress
                    class="mt-3 h-2 w-full accent-zinc-900"
                    [max]="transfer.size || 1"
                    [value]="transfer.bytes"
                    [attr.aria-label]="'Transfer progress for ' + transfer.name"
                  ></progress>
                  <p class="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                    {{ Math.round((transfer.bytes / (transfer.size || 1)) * 100) }}%
                  </p>
                } @else if (transfer.state === 'completed') {
                  <p class="mt-2 text-sm text-emerald-700 dark:text-emerald-300">Received</p>
                } @else if (transfer.error) {
                  <p role="alert" class="mt-2 text-sm text-rose-700 dark:text-rose-300">
                    {{ transfer.error }}
                  </p>
                } @else if (transfer.state === 'queued') {
                  <p class="mt-2 text-sm text-zinc-500">Queued</p>
                } @else if (transfer.state === 'waiting-for-acceptance') {
                  <p class="mt-2 text-sm text-zinc-500">Waiting for acceptance…</p>
                }
              </article>
            }
          </section>
        }
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
  protected readonly helperCopied = signal(false);
  protected readonly overlay = signal({
    left: 0,
    top: 0,
    width: 0,
    height: 0,
    hostWidth: 0,
    hostHeight: 0,
  });
  protected readonly collaborationTools = [
    { id: 'off', label: 'Off', disabled: false },
    { id: 'pointer', label: 'Pointer', disabled: false },
    { id: 'laser', label: 'Laser', disabled: false },
    { id: 'draw', label: 'Draw', disabled: false },
  ] as const;
  protected readonly showConnectionPath = import.meta.env.DEV;
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
  private readonly videoSurface = viewChild<ElementRef<HTMLElement>>('videoSurface');
  private readonly filePickerRef = viewChild<ElementRef<HTMLInputElement>>('filePicker');
  private resizeObserver: ResizeObserver | null = null;
  private observedSurface: HTMLElement | null = null;
  private observedVideos = new Set<HTMLVideoElement>();
  private pendingPointer: {
    readonly mode: 'pointer' | 'laser';
    readonly point: NormalizedPoint;
  } | null = null;
  private pointerFrame: number | null = null;
  private drawing = false;
  private controlButton: { pointerId: number; button: 'left' | 'right' } | null = null;
  protected readonly Math = Math;

  constructor() {
    effect(() => {
      // Once input capture ends (revoke, expiry, surface change) forget any held-button bookkeeping.
      if (!this.session.remoteInput.capturing()) this.controlButton = null;
    });
    effect(() => {
      this.session.collaboration.surfaceRevision();
      this.cancelPendingPointer();
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
      const surface = this.videoSurface()?.nativeElement;
      if (surface !== this.observedSurface) {
        this.resizeObserver?.disconnect();
        this.observedSurface = surface ?? null;
        if (surface && typeof ResizeObserver !== 'undefined') {
          this.resizeObserver ??= new ResizeObserver(() => {
            this.measureOverlay();
          });
          this.resizeObserver.observe(surface);
        }
      }
      const videos = [this.remoteVideo()?.nativeElement, this.localVideo()?.nativeElement].filter(
        (video): video is HTMLVideoElement => video !== undefined,
      );
      for (const video of this.observedVideos) {
        if (!videos.includes(video)) {
          this.resizeObserver?.unobserve(video);
          video.removeEventListener('resize', this.measureOverlay);
          this.observedVideos.delete(video);
        }
      }
      for (const video of videos) {
        if (this.observedVideos.has(video)) continue;
        this.observedVideos.add(video);
        this.resizeObserver?.observe(video);
        video.addEventListener('resize', this.measureOverlay);
      }
      if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(this.measureOverlay);
    });
  }

  protected overlayViewBox(): string {
    const { hostWidth, hostHeight } = this.overlay();
    return `0 0 ${String(Math.max(1, hostWidth))} ${String(Math.max(1, hostHeight))}`;
  }

  protected overlayTransform(): string {
    const { left, top, width, height } = this.overlay();
    return `translate(${String(left)} ${String(top)}) scale(${String(width)} ${String(height)})`;
  }

  protected strokePath(points: readonly NormalizedPoint[]): string {
    return points
      .map((point, index) => `${index ? 'L' : 'M'} ${String(point.x)} ${String(point.y)}`)
      .join(' ');
  }

  protected onSurfacePointerDown(event: PointerEvent): void {
    if (this.session.remoteInput.capturing()) {
      this.controlPointerDown(event);
      return;
    }
    if (this.session.collaboration.tool() !== 'draw') return;
    const point = this.normalizedPoint(event);
    if (!point) return;
    event.preventDefault();
    (event.currentTarget as SVGSVGElement).setPointerCapture(event.pointerId);
    this.drawing = true;
    this.session.collaboration.beginStroke(point);
  }

  protected onSurfacePointerMove(event: PointerEvent): void {
    if (this.session.remoteInput.capturing()) {
      // While a button is held the pointer is captured, so edge overshoot pins to the edge.
      const point = this.normalizedPoint(event, this.controlButton !== null);
      if (point) this.session.remoteInput.movePointer(point);
      return;
    }
    const point = this.normalizedPoint(event);
    if (!point) {
      if (!this.drawing) this.sendPointerHideSoon();
      return;
    }
    if (this.drawing) {
      this.session.collaboration.addStrokePoint(point);
      return;
    }
    const tool = this.session.collaboration.tool();
    if (tool === 'pointer' || tool === 'laser') {
      this.pendingPointer = { mode: tool, point };
      this.pointerFrame ??= requestAnimationFrame(() => {
        this.pointerFrame = null;
        const pending = this.pendingPointer;
        this.pendingPointer = null;
        if (pending) this.session.collaboration.sendPointer(pending.mode, pending.point);
      });
    }
  }

  protected onSurfacePointerUp(event: PointerEvent): void {
    const held = this.controlButton;
    if (held?.pointerId === event.pointerId) {
      this.controlButton = null;
      const target = event.currentTarget as SVGSVGElement;
      const point = this.normalizedPoint(event, true) ?? this.session.remoteInput.lastPointer();
      // Always release: a lost capture, cancel or revoke must never leave the remote button down.
      this.session.remoteInput.pointerButton(held.button, 'up', point);
      if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
      return;
    }
    if (!this.drawing) return;
    this.drawing = false;
    if ((event.currentTarget as SVGSVGElement).hasPointerCapture(event.pointerId))
      (event.currentTarget as SVGSVGElement).releasePointerCapture(event.pointerId);
    this.session.collaboration.finishStroke();
  }

  protected onSurfacePointerLeave(): void {
    if (this.session.remoteInput.capturing()) return;
    if (this.drawing) {
      this.drawing = false;
      this.session.collaboration.finishStroke();
    }
    this.sendPointerHideSoon();
  }

  protected onSurfaceContextMenu(event: Event): void {
    // Only swallow the browser menu while this surface is consuming right clicks as remote input.
    if (this.session.remoteInput.capturing()) event.preventDefault();
  }

  protected onSurfaceWheel(event: WheelEvent): void {
    if (!this.session.remoteInput.capturing() || !this.normalizedPoint(event)) return;
    event.preventDefault();
    const { deltaX, deltaY } = normalizeWheelDelta(event.deltaX, event.deltaY, event.deltaMode);
    this.session.remoteInput.scroll(deltaX, deltaY);
  }

  private controlPointerDown(event: PointerEvent): void {
    if (event.pointerType === 'touch' || this.controlButton) return;
    const button = event.button === 0 ? 'left' : event.button === 2 ? 'right' : null;
    if (!button) return;
    const point = this.normalizedPoint(event);
    if (!point) return;
    event.preventDefault();
    (event.currentTarget as SVGSVGElement).setPointerCapture(event.pointerId);
    this.controlButton = { pointerId: event.pointerId, button };
    this.session.remoteInput.pointerButton(button, 'down', point);
  }

  private readonly measureOverlay = (): void => {
    const host = this.videoSurface()?.nativeElement;
    const video = this.activeVideoElement();
    if (!host || !video) {
      this.overlay.set({ left: 0, top: 0, width: 0, height: 0, hostWidth: 0, hostHeight: 0 });
      return;
    }
    const hostRect = host.getBoundingClientRect();
    const videoRect = video.getBoundingClientRect();
    const content = containedVideoRect(
      videoRect.width,
      videoRect.height,
      video.videoWidth,
      video.videoHeight,
    );
    if (!content) return;
    this.overlay.set({
      left: videoRect.left - hostRect.left + content.left,
      top: videoRect.top - hostRect.top + content.top,
      width: content.width,
      height: content.height,
      hostWidth: hostRect.width,
      hostHeight: hostRect.height,
    });
  };

  private activeVideoElement(): HTMLVideoElement | null {
    if (this.session.collaboration.peerVideoSource() === 'screen')
      return this.remoteVideo()?.nativeElement ?? null;
    if (this.session.collaboration.localVideoSource() === 'screen')
      return this.localVideo()?.nativeElement ?? null;
    return null;
  }

  private normalizedPoint(event: MouseEvent, clamp = false): NormalizedPoint | null {
    const video = this.activeVideoElement();
    if (!video) return null;
    const rect = video.getBoundingClientRect();
    return clientToNormalized(
      event.clientX,
      event.clientY,
      rect,
      video.videoWidth,
      video.videoHeight,
      clamp,
    );
  }

  private sendPointerHideSoon(): void {
    this.cancelPendingPointer();
    if (
      this.session.collaboration.tool() === 'pointer' ||
      this.session.collaboration.tool() === 'laser'
    )
      this.session.collaboration.sendPointerHide();
  }

  private cancelPendingPointer(): void {
    if (this.pointerFrame !== null && typeof cancelAnimationFrame !== 'undefined')
      cancelAnimationFrame(this.pointerFrame);
    this.pointerFrame = null;
    this.pendingPointer = null;
  }

  protected join(): void {
    void this.session.join(this.roomId());
  }
  protected leave(): void {
    this.session.leave();
  }

  protected selectFiles(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files?.length) this.session.fileTransfers.sendFiles([...input.files]);
    input.value = '';
  }

  protected openFilePicker(): void {
    this.filePickerRef()?.nativeElement.click();
  }

  protected acceptFile(id: string): void {
    this.session.fileTransfers.accept(id);
  }
  protected declineFile(id: string): void {
    this.session.fileTransfers.decline(id);
  }
  protected cancelFile(id: string): void {
    this.session.fileTransfers.cancel(id);
  }
  protected dismissTransfer(id: string): void {
    this.session.fileTransfers.dismiss(id);
  }
  protected downloadUrl(id: string): string | null {
    return this.session.fileTransfers.downloadUrl(id);
  }
  protected formatSize(size: number): string {
    return size >= 1024 * 1024
      ? `${(size / 1024 / 1024).toFixed(1)} MB`
      : `${(size / 1024).toFixed(0)} KB`;
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

  protected async copyHelperCode(): Promise<void> {
    this.helperCopied.set(await this.session.copyHelperPairingCode());
    if (this.helperCopied())
      setTimeout(() => {
        this.helperCopied.set(false);
      }, 2000);
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    for (const video of this.observedVideos)
      video.removeEventListener('resize', this.measureOverlay);
    if (this.pointerFrame !== null && typeof cancelAnimationFrame !== 'undefined')
      cancelAnimationFrame(this.pointerFrame);
    for (const ref of [this.remoteAudio(), this.remoteVideo(), this.localVideo()]) {
      if (ref) ref.nativeElement.srcObject = null;
    }
  }
}
