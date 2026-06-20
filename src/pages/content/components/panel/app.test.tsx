import { describe, it, expect, type Mock } from "vitest";
import { render, act } from "@testing-library/react";
import App from "./app";
import { dispatchChromeMessage } from "../../../../../test-utils/vitest.setup";
import { defaultRect, clampRect, rectToTransform, STORAGE_KEY } from "./geometry";

describe("App message listener stability", () => {
  it("registers exactly once and does not re-register when shown toggles", () => {
    const { container } = render(<App />);

    // Mount: the listener was registered exactly once.
    expect(chrome.runtime.onMessage.addListener).toHaveBeenCalledTimes(1);

    const panel = container.querySelector(".commentarium-view");
    expect(panel).not.toBeNull();
    expect(panel).not.toHaveClass("open");

    // First toggle: panel opens.
    act(() => {
      dispatchChromeMessage({ type: "toggle", url: "https://example.com/" });
    });
    expect(panel).toHaveClass("open");

    // Second toggle: panel hides.
    act(() => {
      dispatchChromeMessage({ type: "toggle", url: "https://example.com/" });
    });
    expect(panel).not.toHaveClass("open");

    // The listener was NOT re-registered when shown toggled.
    expect(chrome.runtime.onMessage.addListener).toHaveBeenCalledTimes(1);
  });
});

describe("App restore-on-mount geometry", () => {
  it("applies defaultRect when nothing is stored", async () => {
    const { container } = render(<App />);

    // Flush async restore effect (microtasks + pending promises).
    await act(async () => {});

    const panel = container.querySelector(".commentarium-view") as HTMLElement;
    expect(panel).not.toBeNull();
    expect(panel).not.toHaveClass("restoring");

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const d = defaultRect(vw, vh);

    expect(panel.style.width).toBe(`${d.w}px`);
    expect(panel.style.height).toBe(`${d.h}px`);
    // Panel is closed (shown=false), transform slides off to the right.
    expect(panel.style.transform).toBe(rectToTransform(d, false, vw));

    // Message listener was still registered exactly once.
    expect(chrome.runtime.onMessage.addListener).toHaveBeenCalledTimes(1);
  });

  it("restores geometry from a stored rect on mount", async () => {
    const storedRect = { x: 100, y: 80, w: 320, h: 420 };
    // Pre-seed storage before render so readStoredRect picks it up.
    await chrome.storage.local.set({ [STORAGE_KEY]: storedRect });

    const { container } = render(<App />);
    await act(async () => {});

    const panel = container.querySelector(".commentarium-view") as HTMLElement;
    expect(panel).not.toHaveClass("restoring");

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const expected = clampRect(storedRect, vw, vh);

    expect(panel.style.width).toBe(`${expected.w}px`);
    expect(panel.style.height).toBe(`${expected.h}px`);
    expect(panel.style.transform).toBe(rectToTransform(expected, false, vw));
  });

  it("clamps an off-screen stored rect back on-screen", async () => {
    const offScreenRect = { x: 99999, y: 50, w: 320, h: 420 };
    await chrome.storage.local.set({ [STORAGE_KEY]: offScreenRect });

    const { container } = render(<App />);
    await act(async () => {});

    const panel = container.querySelector(".commentarium-view") as HTMLElement;
    expect(panel).not.toHaveClass("restoring");

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const clamped = clampRect(offScreenRect, vw, vh);

    expect(panel.style.width).toBe(`${clamped.w}px`);
    expect(panel.style.height).toBe(`${clamped.h}px`);

    // Open the panel so shown=true — only then does transform reveal rect.x.
    act(() => {
      dispatchChromeMessage({ type: "toggle", url: "https://example.com/" });
    });
    expect(panel).toHaveClass("open");
    expect(panel.style.transform).toBe(rectToTransform(clamped, true, vw));

    // Parse the RENDERED translateX from the DOM to confirm the panel is
    // actually on-screen, not using the raw 99999 value.
    const txMatch = panel.style.transform.match(/translate\(([-\d.]+)px/);
    expect(txMatch).not.toBeNull();
    const renderedX = Number(txMatch![1]);
    expect(renderedX).toBe(clamped.x);               // rendered uses clamped x
    expect(renderedX).toBeLessThanOrEqual(vw - clamped.w); // and it's on-screen
  });
});

// jsdom has no PointerEvent / pointer capture; the capture calls are stubbed in
// vitest.setup.ts and gestures are driven by dispatching MouseEvents typed as
// pointer events (they carry clientX/clientY/button). This exercises the handler
// wiring + delta math + edge anchoring — NOT real browser pointer capture or the
// iframe pointer-events shield, which stay manual / e2e.
describe("App drag/resize interaction", () => {
  const SEED = { x: 100, y: 100, w: 320, h: 420 };

  async function mountOpened() {
    const utils = render(<App />);
    await act(async () => {}); // flush async restore
    act(() => {
      // open so shown=true reveals x/y in the transform
      dispatchChromeMessage({ type: "toggle", url: "https://example.com/" });
    });
    const panel = utils.container.querySelector(
      ".commentarium-view",
    ) as HTMLElement;
    return { ...utils, panel };
  }

  function firePointer(
    target: EventTarget,
    type: string,
    clientX: number,
    clientY: number,
  ) {
    act(() => {
      target.dispatchEvent(
        new MouseEvent(type, {
          clientX,
          clientY,
          button: 0,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  }

  // Read the rendered geometry back out of the inline style.
  function readGeom(panel: HTMLElement) {
    const m = panel.style.transform.match(
      /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/,
    );
    return {
      x: m ? Number(m[1]) : NaN,
      y: m ? Number(m[2]) : NaN,
      w: parseFloat(panel.style.width),
      h: parseFloat(panel.style.height),
    };
  }

  it("drags the panel by the header and persists the new position on release", async () => {
    await chrome.storage.local.set({ [STORAGE_KEY]: SEED });
    const { container, panel } = await mountOpened();
    (chrome.storage.local.set as unknown as Mock).mockClear();

    const header = container.querySelector(
      ".commentarium-header",
    ) as HTMLElement;

    firePointer(header, "pointerdown", 500, 500);
    // gesture active → the shield class is applied
    expect(panel).toHaveClass("dragging");

    firePointer(window, "pointermove", 560, 540); // dx=60, dy=40
    const g = readGeom(panel);
    expect(g.x).toBe(SEED.x + 60);
    expect(g.y).toBe(SEED.y + 40);
    expect(g.w).toBe(SEED.w); // a move never changes size
    expect(g.h).toBe(SEED.h);

    firePointer(window, "pointerup", 560, 540);
    expect(panel).not.toHaveClass("dragging");
    // final geometry persisted exactly once on gesture end (reads latestRectRef)
    expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      [STORAGE_KEY]: { x: SEED.x + 60, y: SEED.y + 40, w: SEED.w, h: SEED.h },
    });
  });

  it("resizes from the bottom-left handle keeping the top and right edges anchored", async () => {
    await chrome.storage.local.set({ [STORAGE_KEY]: SEED });
    const { container, panel } = await mountOpened();

    const handle = container.querySelector(
      ".commentarium-resize-handle",
    ) as HTMLElement;
    const startRight = SEED.x + SEED.w; // 420
    const startTop = SEED.y; // 100

    firePointer(handle, "pointerdown", 100, 520);
    // dy large enough that the bottom would exceed the viewport — exactly the
    // case where the pre-fix code let clampRect pull the TOP edge up to ~32.
    firePointer(window, "pointermove", 100, 920); // dx=0, dy=400

    const g = readGeom(panel);
    // TOP edge stays anchored (regression guard for the resize-anchor bug).
    expect(g.y).toBe(startTop);
    // RIGHT edge stays anchored.
    expect(g.x + g.w).toBe(startRight);
    // width unchanged (dx=0); height grew but is capped at the space below the top.
    expect(g.w).toBe(SEED.w);
    expect(g.h).toBe(window.innerHeight - startTop); // 768 - 100 = 668

    firePointer(window, "pointerup", 100, 920);
    expect(panel).not.toHaveClass("dragging");
  });
});
