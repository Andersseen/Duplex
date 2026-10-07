import { describe, expect, it } from 'vitest';
import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { roomIdSchema } from '@duplex/protocol';
import LandingPage from './index.page';

function host(fixture: ComponentFixture<unknown>): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

describe('LandingPage', () => {
  it('renders the call-to-action', async () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(LandingPage);
    await fixture.whenStable();

    const element = host(fixture);
    expect(element.querySelector('h1')?.textContent).toContain('Start a call');
    expect(element.querySelector('button')?.textContent.trim()).toBe('Start a call');
  });

  it('navigates to a fresh, valid room when starting a call', async () => {
    TestBed.configureTestingModule({
      providers: [provideRouter([{ path: 'r/:roomId', children: [] }])],
    });
    const fixture = TestBed.createComponent(LandingPage);
    await fixture.whenStable();

    const button = host(fixture).querySelector('button');
    button?.click();
    await fixture.whenStable();

    const url = TestBed.inject(Router).url;
    const roomId = url.replace('/r/', '');
    expect(url.startsWith('/r/')).toBe(true);
    expect(roomIdSchema.safeParse(roomId).success).toBe(true);
  });
});
