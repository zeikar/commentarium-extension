import { describe, it, expect } from "vitest";
import { render, act } from "@testing-library/react";
import App from "./app";
import { dispatchChromeMessage } from "../../../../../test-utils/vitest.setup";

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
