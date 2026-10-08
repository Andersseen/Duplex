export interface ScreenGeometry {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Actual video content bounds for an object-fit: contain video element. */
export function containedVideoRect(
  elementWidth: number,
  elementHeight: number,
  videoWidth: number,
  videoHeight: number,
): ScreenGeometry | null {
  if (
    !Number.isFinite(elementWidth) ||
    !Number.isFinite(elementHeight) ||
    !Number.isFinite(videoWidth) ||
    !Number.isFinite(videoHeight) ||
    elementWidth <= 0 ||
    elementHeight <= 0 ||
    videoWidth <= 0 ||
    videoHeight <= 0
  )
    return null;
  const scale = Math.min(elementWidth / videoWidth, elementHeight / videoHeight);
  const width = videoWidth * scale;
  const height = videoHeight * scale;
  return {
    left: (elementWidth - width) / 2,
    top: (elementHeight - height) / 2,
    width,
    height,
  };
}

/** Map viewport/client coordinates into normalized shared-screen coordinates. */
export function clientToNormalized(
  clientX: number,
  clientY: number,
  element: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  videoWidth: number,
  videoHeight: number,
): { readonly x: number; readonly y: number } | null {
  const content = containedVideoRect(element.width, element.height, videoWidth, videoHeight);
  if (!content) return null;
  const x = clientX - element.left - content.left;
  const y = clientY - element.top - content.top;
  if (x < 0 || y < 0 || x > content.width || y > content.height) return null;
  return { x: x / content.width, y: y / content.height };
}

/** Render normalized shared-screen coordinates in an element's local coordinate space. */
export function normalizedToRender(
  point: { readonly x: number; readonly y: number },
  elementWidth: number,
  elementHeight: number,
  videoWidth: number,
  videoHeight: number,
): { readonly x: number; readonly y: number } | null {
  const content = containedVideoRect(elementWidth, elementHeight, videoWidth, videoHeight);
  if (
    !content ||
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    point.x < 0 ||
    point.x > 1 ||
    point.y < 0 ||
    point.y > 1
  )
    return null;
  return { x: content.left + point.x * content.width, y: content.top + point.y * content.height };
}
