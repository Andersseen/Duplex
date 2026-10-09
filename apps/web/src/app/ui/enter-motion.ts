import { afterNextRender, Directive, ElementRef, inject, Injector } from '@angular/core';

import type * as AngularMovement from 'angular-movement';

type Movement = typeof AngularMovement;

let movement: Movement | null = null;
let loading: Promise<void> | null = null;

/**
 * Angular Movement is loaded on demand, after the first render, so it never counts toward the
 * initial JavaScript of the landing page or the call route. Until it has loaded, elements simply
 * appear without animation.
 */
export function preloadMovement(): void {
  loading ??= import('angular-movement')
    .then((module) => {
      movement = module;
    })
    .catch(() => undefined);
}

/** A short fade-and-rise when a contextual panel or state card appears. Reduced motion is honored by the library. */
@Directive({ selector: '[dxEnter]' })
export class EnterMotion {
  constructor() {
    const element = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const injector = inject(Injector);
    afterNextRender(() => {
      preloadMovement();
      if (!movement) return;
      injector
        .get(movement.MoveAnimator)
        .animate(element, { opacity: [0, 1], y: [12, 0] }, { duration: '220ms' });
    });
  }
}
