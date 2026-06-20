import { describe, it, expect } from "vitest";
import {
  MIN_W,
  MIN_H,
  MARGIN,
  clampRect,
  defaultRect,
  rectToTransform,
  parseStoredRect,
  rectsEqual,
} from "./geometry";

describe("defaultRect", () => {
  it("docks to the right edge with MARGIN gap", () => {
    const r = defaultRect(1200, 800);
    expect(r.w).toBe(400);
    expect(r.h).toBe(800 - 2 * MARGIN);
    expect(r.x).toBe(1200 - 400 - MARGIN);
    expect(r.y).toBe(MARGIN);
  });

  it("caps width when viewport is narrow", () => {
    // viewport 500px wide — 500-32=468 > 400, so the 400 cap applies
    const r = defaultRect(500, 800);
    expect(r.w).toBe(400);
  });
});

describe("clampRect — normal viewport", () => {
  it("clamps oversized width down to effectiveMaxW", () => {
    const r = clampRect({ x: 0, y: 0, w: 2000, h: 400 }, 1200, 800);
    expect(r.w).toBe(1200 - 2 * MARGIN);
  });

  it("clamps undersized width up to MIN_W", () => {
    const r = clampRect({ x: 0, y: 0, w: 50, h: 400 }, 1200, 800);
    expect(r.w).toBe(MIN_W);
  });

  it("clamps oversized height down to effectiveMaxH", () => {
    const r = clampRect({ x: 0, y: 0, w: 400, h: 5000 }, 1200, 800);
    expect(r.h).toBe(800 - 2 * MARGIN);
  });

  it("clamps undersized height up to MIN_H", () => {
    const r = clampRect({ x: 0, y: 0, w: 400, h: 10 }, 1200, 800);
    expect(r.h).toBe(MIN_H);
  });

  it("pulls off-screen x back on-screen", () => {
    const r = clampRect({ x: 9999, y: 0, w: 400, h: 400 }, 1200, 800);
    expect(r.x).toBe(1200 - r.w);
  });

  it("pulls off-screen y back on-screen", () => {
    const r = clampRect({ x: 0, y: 9999, w: 400, h: 400 }, 1200, 800);
    expect(r.y).toBe(800 - r.h);
  });

  it("clamps negative x to 0", () => {
    const r = clampRect({ x: -100, y: 0, w: 400, h: 400 }, 1200, 800);
    expect(r.x).toBe(0);
  });
});

describe("clampRect — small viewport (MIN_W=280, MARGIN=16, viewportW=300)", () => {
  // effectiveMaxW = 300 - 2*16 = 268, which is less than MIN_W (280).
  // So effectiveMinW = min(280, 268) = 268. Oversized rect should clamp to 268.
  it("shrinks panel below MIN_W rather than overflowing — w == effectiveMaxW (268)", () => {
    const r = clampRect({ x: 0, y: 0, w: 500, h: 400 }, 300, 800);
    const effectiveMaxW = 300 - 2 * MARGIN; // 268
    expect(r.w).toBe(effectiveMaxW);
    expect(r.w).not.toBe(MIN_W);
  });

  it("x is clamped to viewportW - w when the panel fills the available width", () => {
    const r = clampRect({ x: 50, y: 0, w: 500, h: 400 }, 300, 800);
    // viewportW - w = 300 - 268 = 32, so x is clamped to min(50, 32) = 32
    expect(r.x).toBe(300 - r.w);
  });
});

describe("rectToTransform", () => {
  it("returns translate at rect position when shown", () => {
    const r = { x: 100, y: 50, w: 400, h: 600 };
    expect(rectToTransform(r, true, 1200)).toBe("translate(100px, 50px)");
  });

  it("returns translate to viewportW when closed", () => {
    const r = { x: 100, y: 50, w: 400, h: 600 };
    expect(rectToTransform(r, false, 1200)).toBe("translate(1200px, 50px)");
  });
});

describe("parseStoredRect", () => {
  it("accepts a valid PanelRect object", () => {
    const r = parseStoredRect({ x: 10, y: 20, w: 300, h: 500 });
    expect(r).toEqual({ x: 10, y: 20, w: 300, h: 500 });
  });

  it("returns null for null", () => {
    expect(parseStoredRect(null)).toBeNull();
  });

  it("returns null for a string", () => {
    expect(parseStoredRect("{}")).toBeNull();
  });

  it("returns null when a field is missing", () => {
    expect(parseStoredRect({ x: 10, y: 20, w: 300 })).toBeNull();
  });

  it("returns null when a field is NaN", () => {
    expect(parseStoredRect({ x: NaN, y: 20, w: 300, h: 500 })).toBeNull();
  });

  it("returns null when a field is Infinity", () => {
    expect(parseStoredRect({ x: Infinity, y: 20, w: 300, h: 500 })).toBeNull();
  });

  it("returns null for an array", () => {
    expect(parseStoredRect([10, 20, 300, 500])).toBeNull();
  });
});

describe("rectsEqual", () => {
  it("returns true for identical rects", () => {
    expect(rectsEqual({ x: 1, y: 2, w: 3, h: 4 }, { x: 1, y: 2, w: 3, h: 4 })).toBe(true);
  });

  it("returns false when x differs", () => {
    expect(rectsEqual({ x: 1, y: 2, w: 3, h: 4 }, { x: 9, y: 2, w: 3, h: 4 })).toBe(false);
  });

  it("returns false when y differs", () => {
    expect(rectsEqual({ x: 1, y: 2, w: 3, h: 4 }, { x: 1, y: 9, w: 3, h: 4 })).toBe(false);
  });

  it("returns false when w differs", () => {
    expect(rectsEqual({ x: 1, y: 2, w: 3, h: 4 }, { x: 1, y: 2, w: 9, h: 4 })).toBe(false);
  });

  it("returns false when h differs", () => {
    expect(rectsEqual({ x: 1, y: 2, w: 3, h: 4 }, { x: 1, y: 2, w: 3, h: 9 })).toBe(false);
  });
});
