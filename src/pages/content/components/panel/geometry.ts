export type PanelRect = { x: number; y: number; w: number; h: number };

export const MIN_W = 280;
export const MIN_H = 200;
export const MARGIN = 16;
export const STORAGE_KEY = "commentarium.panel.rect";

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/**
 * Clamp rect to be fully on-screen.
 * Small-viewport rule: when the viewport is narrower than MIN_W + 2*MARGIN,
 * effectiveMaxW wins and the panel shrinks below MIN_W rather than overflowing.
 */
export function clampRect(
  rect: PanelRect,
  viewportW: number,
  viewportH: number,
): PanelRect {
  const effectiveMaxW = Math.max(0, viewportW - 2 * MARGIN);
  const effectiveMinW = Math.min(MIN_W, effectiveMaxW);
  const w = clamp(rect.w, effectiveMinW, effectiveMaxW);

  const effectiveMaxH = Math.max(0, viewportH - 2 * MARGIN);
  const effectiveMinH = Math.min(MIN_H, effectiveMaxH);
  const h = clamp(rect.h, effectiveMinH, effectiveMaxH);

  // position clamped against the resolved (post-clamp) size
  const x = clamp(rect.x, 0, Math.max(0, viewportW - w));
  const y = clamp(rect.y, 0, Math.max(0, viewportH - h));

  return { x, y, w, h };
}

/** Default right-edge dock position. */
export function defaultRect(viewportW: number, viewportH: number): PanelRect {
  const w = Math.min(400, viewportW - 2 * MARGIN);
  const h = viewportH - 2 * MARGIN;
  const x = viewportW - w - MARGIN;
  const y = MARGIN;
  return clampRect({ x, y, w, h }, viewportW, viewportH);
}

/** CSS transform string — slides off-screen to the right when closed. */
export function rectToTransform(
  rect: PanelRect,
  shown: boolean,
  viewportW: number,
): string {
  const tx = shown ? rect.x : viewportW;
  return `translate(${tx}px, ${rect.y}px)`;
}

/** Parse a chrome.storage value; return null if it is not a valid PanelRect. */
export function parseStoredRect(raw: unknown): PanelRect | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  for (const field of ["x", "y", "w", "h"] as const) {
    if (typeof r[field] !== "number" || !Number.isFinite(r[field] as number)) {
      return null;
    }
  }
  return {
    x: r["x"] as number,
    y: r["y"] as number,
    w: r["w"] as number,
    h: r["h"] as number,
  };
}

/** Field-wise equality — used by the deterministic restore-write rule. */
export function rectsEqual(a: PanelRect, b: PanelRect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}
