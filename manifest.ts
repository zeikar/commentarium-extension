import packageJson from "./package.json";

export type ManifestEnv = {
  /**
   * Web-application OAuth client_id used by chrome.identity.launchWebAuthFlow.
   * NOT the legacy "Chrome App" client; that one was tied to the manifest
   * `oauth2` field (now removed) and has no redirect URI we can use here.
   * Authorized redirect URI in Google Cloud Console must be exactly
   * `https://<EXT_ID>.chromiumapp.org/` (trailing slash) to match what
   * chrome.identity.getRedirectURL() returns.
   */
  VITE_GOOGLE_OAUTH_WEB_CLIENT_ID?: string;
  /**
   * Optional but strongly recommended for unpacked local dev: pin the
   * extension to the production ID by supplying its RSA public key
   * (base64-encoded SubjectPublicKeyInfo). With it set, two things line
   * up to the prod ID:
   *   1. chrome.runtime.sendMessage from the deployed webapp, which
   *      hardcodes the prod EXT_ID, reaches the local SW.
   *   2. chrome.identity.getRedirectURL() returns the redirect URI
   *      that's authorized in Google Cloud Console for the shared Web
   *      OAuth client. Without this, a random local EXT_ID makes Google
   *      reject the OAuth flow with redirect_uri_mismatch.
   * Production Web Store publishes leave this unset — the Web Store
   * assigns the ID.
   */
  VITE_EXTENSION_KEY?: string;
};

const REQUIRED_KEYS: (keyof ManifestEnv)[] = [
  "VITE_GOOGLE_OAUTH_WEB_CLIENT_ID",
];

/**
 * After changing, please reload the extension at `chrome://extensions`
 */
export function buildManifest(
  env: ManifestEnv,
  opts: { isDev?: boolean } = {},
): chrome.runtime.ManifestV3 {
  const missing = REQUIRED_KEYS.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(
      `buildManifest: missing required env keys: ${missing.join(", ")}. ` +
        `Set them in .env.local (see .env.example).`,
    );
  }

  // Dev builds get a "(DEV)" suffix so a developer running the unpacked
  // build alongside the Web Store install can tell them apart in
  // chrome://extensions and the toolbar tooltip. The toolbar badge
  // ("DEV", red) is set at runtime by the background SW.
  const name = opts.isDev ? `${packageJson.name} (DEV)` : packageJson.name;

  const manifest: chrome.runtime.ManifestV3 = {
    manifest_version: 3,
    name,
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
    icons: {
      "32": "commentarium-logo-32.png",
      "48": "commentarium-logo-48.png",
      "128": "commentarium-logo-128.png",
    },
    content_scripts: [
      {
        matches: ["http://*/*", "https://*/*"],
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
