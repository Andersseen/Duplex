import '@angular/compiler';
import '@analogjs/vitest-angular/setup-snapshots';
import { setupTestBed } from '@analogjs/vitest-angular/setup-testbed';
import '@testing-library/jest-dom/vitest';

// jsdom has no IntersectionObserver; angular-movement's in-view directive needs one. The stub never
// reports an intersection, so scroll-triggered motion simply stays at rest in unit tests.
class NoopIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = '';
  readonly scrollMargin = '';
  readonly thresholds = [];
  observe(): void {
    return;
  }
  unobserve(): void {
    return;
  }
  disconnect(): void {
    return;
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}
// Not every jsdom version defines it; the cast keeps the guard honest for the type checker.
(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver ??=
  NoopIntersectionObserver;

setupTestBed();
