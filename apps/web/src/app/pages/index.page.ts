import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { createRoomId } from '@duplex/protocol';

const REPO_URL = 'https://github.com/Andersseen/Duplex';

@Component({
  selector: 'dx-landing-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'mx-auto flex min-h-dvh w-full max-w-5xl flex-col px-6 py-6 sm:px-10' },
  template: `
    <header class="flex items-center justify-between">
      <span class="text-lg font-semibold tracking-tight">Duplex</span>
      <nav aria-label="Project links" class="flex gap-5 text-sm text-ink-muted">
        <a class="underline-offset-4 hover:text-ink hover:underline" [href]="docsUrl">Docs</a>
        <a class="underline-offset-4 hover:text-ink hover:underline" [href]="repoUrl">GitHub</a>
      </nav>
    </header>

    <main class="flex flex-1 flex-col gap-20 py-16 sm:py-24">
      <section class="dx-rise flex flex-col items-start gap-6" aria-labelledby="hero-title">
        <h1 id="hero-title" class="text-5xl font-semibold tracking-tight sm:text-7xl">
          Call. Share. Help.
        </h1>
        <p class="max-w-2xl text-lg text-ink-muted sm:text-xl">
          Private 1:1 calls, screen sharing, collaboration and remote assistance — from one link. No
          account, no install to join.
        </p>
        <button
          type="button"
          class="min-h-12 rounded-full bg-ink px-7 py-3.5 text-base font-medium text-ink-inverse transition-transform duration-150 hover:scale-[1.02] active:scale-100"
          (click)="startCall()"
        >
          Start a call
        </button>
        <ul class="flex flex-wrap gap-x-6 gap-y-1 text-sm text-ink-muted">
          <li>No account</li>
          <li>Peer-to-peer media and data</li>
          <li>Remote control only with temporary permission</li>
        </ul>
      </section>

      <section aria-labelledby="capabilities-title">
        <h2 id="capabilities-title" class="mb-6 text-2xl font-semibold tracking-tight">
          What you can do
        </h2>
        <div class="grid gap-4 sm:grid-cols-3">
          @for (item of capabilities; track item.title) {
            <article class="rounded-2xl border border-line bg-surface p-5">
              <h3 class="font-semibold">{{ item.title }}</h3>
              <p class="mt-2 text-sm text-ink-muted">{{ item.body }}</p>
            </article>
          }
        </div>
      </section>

      <section aria-labelledby="how-title">
        <h2 id="how-title" class="mb-6 text-2xl font-semibold tracking-tight">How it works</h2>
        <ol class="grid gap-4 sm:grid-cols-3">
          @for (step of steps; track step.title; let index = $index) {
            <li class="rounded-2xl border border-line p-5">
              <span class="text-sm text-ink-muted">Step {{ index + 1 }}</span>
              <h3 class="mt-1 font-semibold">{{ step.title }}</h3>
              <p class="mt-2 text-sm text-ink-muted">{{ step.body }}</p>
            </li>
          }
        </ol>
      </section>

      <section aria-labelledby="privacy-title">
        <h2 id="privacy-title" class="mb-6 text-2xl font-semibold tracking-tight">
          Privacy and consent
        </h2>
        <ul class="grid gap-3 text-ink-muted sm:grid-cols-3">
          <li class="rounded-2xl bg-surface-muted p-5">
            <strong class="text-ink">Ephemeral rooms.</strong> A room is an unguessable link for at
            most two people. Nothing is stored after the call.
          </li>
          <li class="rounded-2xl bg-surface-muted p-5">
            <strong class="text-ink">Peer-to-peer.</strong> Media, files and pointer data go
            directly between browsers. Servers only help you connect.
          </li>
          <li class="rounded-2xl bg-surface-muted p-5">
            <strong class="text-ink">Explicit consent.</strong> Remote control needs a paired helper
            and an Allow click, and expires on its own.
          </li>
        </ul>
      </section>

      <section aria-labelledby="status-title">
        <h2 id="status-title" class="mb-6 text-2xl font-semibold tracking-tight">
          Platform status
        </h2>
        <dl class="divide-y divide-line rounded-2xl border border-line bg-surface">
          @for (row of platforms; track row.name) {
            <div class="flex flex-wrap justify-between gap-2 px-5 py-3">
              <dt class="font-medium">{{ row.name }}</dt>
              <dd class="text-ink-muted">{{ row.state }}</dd>
            </div>
          }
        </dl>
      </section>
    </main>

    <footer
      class="flex flex-wrap justify-between gap-2 border-t border-line pt-6 text-sm text-ink-muted"
    >
      <span>Duplex — private by design, experimental Assist.</span>
      <a class="underline underline-offset-4" [href]="repoUrl">Source on GitHub</a>
    </footer>
  `,
})
export default class LandingPage {
  private readonly router = inject(Router);

  protected readonly repoUrl = REPO_URL;
  protected readonly docsUrl = `${REPO_URL}/tree/main/docs`;
  protected readonly capabilities = [
    {
      title: 'Live',
      body: 'Audio calls, optional camera and screen sharing, with a direct or relayed path shown honestly.',
    },
    {
      title: 'Collaborate',
      body: 'Send files peer-to-peer and point, use a laser or draw on the shared screen.',
    },
    {
      title: 'Assist',
      body: 'Ask to control a shared screen. The sharer approves a temporary, scoped session.',
    },
  ] as const;
  protected readonly steps = [
    {
      title: 'Create a link',
      body: 'Start a call. A random room link is generated in your browser.',
    },
    { title: 'Send it', body: 'Share the link with one person. The room holds two participants.' },
    { title: 'Call, share, help', body: 'Talk, share a screen, send files or request control.' },
  ] as const;
  protected readonly platforms = [
    {
      name: 'Browser calling',
      state: 'Modern Chromium-based browsers (tested); other browsers best effort',
    },
    { name: 'Native pointer Assist', state: 'macOS only — experimental' },
    { name: 'Keyboard control', state: 'Not available yet' },
    { name: 'Windows / Linux control', state: 'Not available yet' },
  ] as const;

  protected startCall(): void {
    // Room IDs are opaque 128-bit random tokens. A room only comes to exist when
    // its Durable Object is first addressed, so there is nothing to create yet.
    void this.router.navigate(['/r', createRoomId()]);
  }
}
