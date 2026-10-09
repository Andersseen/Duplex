import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { roomIdSchema } from '@duplex/protocol';
import { render, screen } from '@testing-library/angular';
import { userEvent } from '@testing-library/user-event';
import LandingPage from './index.page';

async function renderLanding() {
  return render(LandingPage, {
    providers: [provideRouter([{ path: 'r/:roomId', children: [] }])],
  });
}

describe('LandingPage', () => {
  it('states what Duplex is and offers a single call-to-action', async () => {
    await renderLanding();

    expect(screen.getByRole('heading', { level: 1, name: 'Call. Share. Help.' })).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Start a call' })).toHaveLength(1);
  });

  it('describes capabilities, privacy and honest platform status', async () => {
    await renderLanding();

    for (const name of [
      'What you can do',
      'How it works',
      'Privacy and consent',
      'Platform status',
    ])
      expect(screen.getByRole('heading', { level: 2, name })).toBeInTheDocument();
    expect(screen.getByText('macOS only — experimental')).toBeInTheDocument();
    expect(screen.getAllByText('Not available yet', { selector: 'dd' })).toHaveLength(2);
  });

  it('links to the documentation and source', async () => {
    await renderLanding();

    expect(screen.getByRole('link', { name: 'Docs' })).toHaveAttribute(
      'href',
      expect.stringContaining('github.com/Andersseen/Duplex'),
    );
    expect(screen.getByRole('link', { name: 'GitHub' })).toBeInTheDocument();
  });

  it('navigates to a fresh, valid room when starting a call', async () => {
    const user = userEvent.setup();
    await renderLanding();

    await user.click(screen.getByRole('button', { name: 'Start a call' }));

    const url = TestBed.inject(Router).url;
    expect(url.startsWith('/r/')).toBe(true);
    expect(roomIdSchema.safeParse(url.replace('/r/', '')).success).toBe(true);
  });
});
