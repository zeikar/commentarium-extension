import packageJson from "./package.json";

export type ManifestEnv = {
  VITE_GOOGLE_OAUTH_CLIENT_ID?: string;
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

  return {
    manifest_version: 3,
    name: packageJson.name,
    version: packageJson.version,
    description: packageJson.description,
    minimum_chrome_version: "132",
    background: {
      service_worker: "src/pages/background/index.js",
      type: "module",
    },
    action: {},
    permissions: ["activeTab", "identity", "storage", "cookies"],
    host_permissions: ["https://commentarium.app/*"],
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
}
