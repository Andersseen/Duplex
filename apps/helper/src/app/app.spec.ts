import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { App } from './app';

describe('App', () => {
  it('states its purpose and that it is not connected', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('h1')?.textContent).toBe('Duplex');
    expect(element.textContent).toContain('Remote Control Helper');
    expect(element.querySelector('[role="status"]')?.textContent).toBe('Not connected to a call');
  });
});
