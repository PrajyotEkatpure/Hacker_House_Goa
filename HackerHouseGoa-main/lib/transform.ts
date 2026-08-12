/**
 * Cover-fit geometry shared by the editor and the compositors.
 *
 * Both the on-screen preview and the exported PNG call `placePhoto`, so what the
 * user drags into place is exactly what gets rendered. Any divergence here shows
 * up as "the export doesn't match the preview", so this is deliberately the only
 * place that knows how a photo maps into a region.
 */

import type { Rect, SourceImage, Transform } from "./types";

/** Hard limits on the zoom slider / pinch gesture. */
export const MIN_SCALE = 1;
export const MAX_SCALE = 4;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Where the photo lands, in design space, for a given region + transform.
 * The returned rect always fully contains `region`.
 */
export function placePhoto(
  region: Rect,
  photo: { width: number; height: number },
  transform: Transform,
): Rect {
  const t = clampTransform(region, photo, transform);
  // Cover-fit: the smaller of the two axes has to reach, so take the max ratio.
  const base = Math.max(region.w / photo.width, region.h / photo.height);
  const w = photo.width * base * t.scale;
  const h = photo.height * base * t.scale;
  const cx = region.x + region.w / 2;
  const cy = region.y + region.h / 2;
  return {
    x: cx - w / 2 + t.offsetX * region.w,
    y: cy - h / 2 + t.offsetY * region.h,
    w,
    h,
  };
}

/**
 * Clamp a transform so the photo can never expose an edge of the region.
 *
 * At scale 1 the photo covers the region on one axis exactly, so the offset on
 * that axis is pinned to 0 while the other axis still has slack to slide.
 */
export function clampTransform(
  region: Rect,
  photo: { width: number; height: number },
  transform: Transform,
): Transform {
  const scale = clamp(transform.scale, MIN_SCALE, MAX_SCALE);
  const base = Math.max(region.w / photo.width, region.h / photo.height);
  const w = photo.width * base * scale;
  const h = photo.height * base * scale;
  // Slack is half the overhang, expressed as a fraction of the region.
  // Math.max guards against sub-pixel negatives from floating point.
  const slackX = Math.max(0, (w - region.w) / 2 / region.w);
  const slackY = Math.max(0, (h - region.h) / 2 / region.h);
  return {
    scale,
    offsetX: clamp(transform.offsetX, -slackX, slackX),
    offsetY: clamp(transform.offsetY, -slackY, slackY),
  };
}

/**
 * Translate a drag in *screen* pixels into a transform delta.
 * `previewWidth` is the on-screen width of the region the user is dragging in.
 */
export function panBy(
  region: Rect,
  photo: { width: number; height: number },
  transform: Transform,
  dxScreen: number,
  dyScreen: number,
  previewScale: number,
): Transform {
  // previewScale = on-screen px per design px.
  const dxDesign = dxScreen / previewScale;
  const dyDesign = dyScreen / previewScale;
  return clampTransform(region, photo, {
    scale: transform.scale,
    offsetX: transform.offsetX + dxDesign / region.w,
    offsetY: transform.offsetY + dyDesign / region.h,
  });
}

/**
 * Zoom around the region centre, keeping the framing as stable as the clamp allows.
 */
export function zoomTo(
  region: Rect,
  photo: { width: number; height: number },
  transform: Transform,
  nextScale: number,
): Transform {
  const scale = clamp(nextScale, MIN_SCALE, MAX_SCALE);
  const ratio = scale / transform.scale;
  return clampTransform(region, photo, {
    scale,
    // Offsets are fractions of the region, and the photo grows about its own
    // centre, so the visible framing scales with it.
    offsetX: transform.offsetX * ratio,
    offsetY: transform.offsetY * ratio,
  });
}

/** Draw the photo into `region`, clipped to whatever path the caller has set. */
export function drawPhoto(
  ctx: CanvasRenderingContext2D,
  source: SourceImage,
  region: Rect,
  transform: Transform,
): void {
  const r = placePhoto(region, source, transform);
  ctx.drawImage(source.bitmap, r.x, r.y, r.w, r.h);
}
