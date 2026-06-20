import { describe, it, expect } from "vitest";
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
