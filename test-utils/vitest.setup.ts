import { vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";

type ChromeMessageListener = (msg: unknown, sender: unknown) => void;

const listeners: ChromeMessageListener[] = [];

const addListener = vi.fn((cb: ChromeMessageListener) => {
  listeners.push(cb);
});

const removeListener = vi.fn((cb: ChromeMessageListener) => {
  const i = listeners.indexOf(cb);
  if (i !== -1) listeners.splice(i, 1);
});

(globalThis as unknown as { chrome: unknown }).chrome = {
  runtime: {
    onMessage: { addListener, removeListener },
  },
};

beforeEach(() => {
  addListener.mockClear();
  removeListener.mockClear();
  listeners.length = 0;
});

export function dispatchChromeMessage(
  msg: unknown,
  sender: unknown = {}
): void {
  for (const l of [...listeners]) {
    l(msg, sender);
  }
}
