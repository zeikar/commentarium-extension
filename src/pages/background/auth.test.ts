import { describe, it, expect } from "vitest";
import { dispatchExternalMessage } from "../../../test-utils/vitest.setup";

describe("dispatchExternalMessage helper", () => {
  it("resolves to undefined when no listener is registered", async () => {
    const result = await dispatchExternalMessage({ type: "noop" });
    expect(result).toBeUndefined();
  });
});
