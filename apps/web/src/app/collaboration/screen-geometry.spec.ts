import { describe, expect, it } from 'vitest';
import { clientToNormalized, containedVideoRect, normalizedToRender } from './screen-geometry';

describe('screen geometry', () => {
  it('uses the full element when aspect ratios match', () => {
    expect(containedVideoRect(1600, 900, 1600, 900)).toEqual({
      left: 0,
      top: 0,
      width: 1600,
      height: 900,
    });
  });

  it('finds horizontal and vertical letterboxing', () => {
    expect(containedVideoRect(1000, 1000, 16, 9)).toEqual({
      left: 0,
      top: 218.75,
      width: 1000,
      height: 562.5,
    });
    expect(containedVideoRect(1000, 500, 9, 16)).toEqual({
      left: 359.375,
      top: 0,
      width: 281.25,
      height: 500,
    });
  });

  it('maps the content corners and rejects letterbox margins', () => {
    const element = { left: 20, top: 10, width: 1000, height: 1000 };
    expect(clientToNormalized(20, 228.75, element, 16, 9)).toEqual({ x: 0, y: 0 });
    expect(clientToNormalized(520, 510, element, 16, 9)).toEqual({ x: 0.5, y: 0.5 });
    expect(clientToNormalized(1020, 791.25, element, 16, 9)).toEqual({ x: 1, y: 1 });
    expect(clientToNormalized(520, 100, element, 16, 9)).toBeNull();
    expect(clientToNormalized(19, 510, element, 16, 9)).toBeNull();
  });

  it('maps normalized coordinates to render coordinates and round trips', () => {
    const normalized = { x: 0.42, y: 0.73 };
    const rendered = normalizedToRender(normalized, 1000, 1000, 16, 9);
    expect(rendered).toEqual({ x: 420, y: 629.375 });
    expect(
      rendered &&
        clientToNormalized(
          rendered.x,
          rendered.y,
          { left: 0, top: 0, width: 1000, height: 1000 },
          16,
          9,
        ),
    ).toEqual(normalized);
    expect(normalizedToRender(normalized, 1000, 500, 9, 16)).toEqual({
      x: 477.5,
      y: 365,
    });
  });

  it('recalculates mapping when an element resizes and rejects invalid dimensions', () => {
    expect(containedVideoRect(800, 450, 16, 9)).toEqual({
      left: 0,
      top: 0,
      width: 800,
      height: 450,
    });
    expect(containedVideoRect(800, 600, 16, 9)).toEqual({
      left: 0,
      top: 75,
      width: 800,
      height: 450,
    });
    expect(containedVideoRect(0, 600, 16, 9)).toBeNull();
  });
});
