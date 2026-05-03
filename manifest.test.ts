import { describe, expect, it } from "vitest";
import { buildManifest } from "./manifest";

const baseEnv = {
  VITE_GOOGLE_OAUTH_CLIENT_ID: "test-client.apps.googleusercontent.com",
};

describe("buildManifest — CHIPS contract", () => {
  it("does NOT ship a hardcoded `key` field when VITE_EXTENSION_KEY is unset", () => {
    const m = buildManifest(baseEnv);
    expect((m as { key?: string }).key).toBeUndefined();
  });

  it("includes `key` from VITE_EXTENSION_KEY when the env var is set (unpacked-dev parity)", () => {
    const m = buildManifest({ ...baseEnv, VITE_EXTENSION_KEY: "DEV_KEY_VALUE" });
    expect((m as { key?: string }).key).toBe("DEV_KEY_VALUE");
  });

  it("does not include host_permissions", () => {
    const m = buildManifest(baseEnv);
    expect((m as { host_permissions?: unknown }).host_permissions).toBeUndefined();
  });

  it("does not include the `cookies` permission", () => {
    const m = buildManifest(baseEnv);
    expect(m.permissions).not.toContain("cookies");
  });

  it("permissions are exactly activeTab + identity + storage", () => {
    const m = buildManifest(baseEnv);
    expect(m.permissions?.sort()).toEqual(["activeTab", "identity", "storage"].sort());
  });

  it("minimum_chrome_version is 114 (CHIPS floor)", () => {
    const m = buildManifest(baseEnv);
    expect(m.minimum_chrome_version).toBe("114");
  });

  it("externally_connectable still pins to commentarium.app/*", () => {
    const m = buildManifest(baseEnv);
    expect(m.externally_connectable?.matches).toEqual(["https://commentarium.app/*"]);
  });
});
