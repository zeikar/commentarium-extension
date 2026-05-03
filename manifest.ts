import packageJson from "./package.json";

export type ManifestEnv = {
  VITE_GOOGLE_OAUTH_CLIENT_ID?: string;
  /**
   * Optional: pin the unpacked-dev extension to a fixed ID by supplying the
   * extension's RSA public key (base64-encoded SubjectPublicKeyInfo). Used so
   * that local devs running an unpacked build can talk to the deployed
   * webapp, which hardcodes the prod extension ID. Production Web Store
   * publishes leave this unset — the Web Store assigns the ID.
   */
  VITE_EXTENSION_KEY?: string;
};

const REQUIRED_KEYS: (keyof ManifestEnv)[] = ["VITE_GOOGLE_OAUTH_CLIENT_ID"];

/**
 * After changing, please reload the extension at `chrome://extensions`
 */
export function buildManifest(env: ManifestEnv): chrome.runtime.ManifestV3 {
  const missing = REQUIRED_KEYS.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(
      `buildManifest: missing required env keys: ${missing.join(", ")}. ` +
        `Set them in .env.local (see .env.example).`,
    );
  }

  const manifest: chrome.runtime.ManifestV3 = {
    manifest_version: 3,
    name: packageJson.name,
    version: packageJson.version,
    description: packageJson.description,
    minimum_chrome_version: "114",
    background: {
      service_worker: "src/pages/background/index.js",
      type: "module",
    },
    action: {},
    permissions: ["activeTab", "identity", "storage"],
    externally_connectable: {
      matches: ["https://commentarium.app/*"],
    },
    oauth2: {
      client_id: env.VITE_GOOGLE_OAUTH_CLIENT_ID!,
      scopes: ["openid", "email", "profile"],
    },
    icons: {
      "32": "commentarium-logo-32.png",
      "48": "commentarium-logo-48.png",
      "128": "commentarium-logo-128.png",
    },
    content_scripts: [
      {
        matches: ["http://*/*", "https://*/*", "<all_urls>"],
        js: ["src/pages/content/index.js"],
        // KEY for cache invalidation
        css: ["assets/css/contentStyle<KEY>.chunk.css"],
      },
    ],
    web_accessible_resources: [
      {
        resources: [
          "assets/js/*.js",
          "assets/css/*.css",
          "commentarium-logo-128.png",
          "commentarium-logo-32.png",
        ],
        matches: ["*://*/*"],
      },
    ],
  };

  if (env.VITE_EXTENSION_KEY) {
    manifest.key = env.VITE_EXTENSION_KEY;
  }

  return manifest;
}
