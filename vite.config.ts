/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path, { resolve } from "path";
import makeManifest from "./utils/plugins/make-manifest";
import customDynamicImport from "./utils/plugins/custom-dynamic-import";
import addHmr from "./utils/plugins/add-hmr";
import { buildManifest } from "./manifest";

const root = resolve(__dirname, "src");
const pagesDir = resolve(root, "pages");
const assetsDir = resolve(root, "assets");
const outDir = resolve(__dirname, "dist");
const publicDir = resolve(__dirname, "public");

const isDev = process.env.__DEV__ === "true";
const isProduction = !isDev;

// ENABLE HMR IN BACKGROUND SCRIPT
const enableHmrInBackgroundScript = true;

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const isBuild = command === "build";
  const manifestPlugin = isBuild
    ? [
        makeManifest(buildManifest(env), {
          isDev,
          contentScriptCssKey: regenerateCacheInvalidationKey(),
        }),
      ]
    : [];
  return {
    resolve: {
      alias: {
        "@src": root,
        "@assets": assetsDir,
        "@pages": pagesDir,
      },
    },
    plugins: [
      react(),
      ...manifestPlugin,
      customDynamicImport(),
      addHmr({ background: enableHmrInBackgroundScript, view: true }),
    ],
    publicDir,
    build: {
      outDir,
      /** Can slowDown build speed. */
      // sourcemap: isDev,
      minify: isProduction,
      reportCompressedSize: isProduction,
      rollupOptions: {
        input: {
          content: resolve(pagesDir, "content", "index.ts"),
          background: resolve(pagesDir, "background", "index.ts"),
          contentStyle: resolve(pagesDir, "content", "style.scss"),
        },
        watch: {
          include: ["src/**", "vite.config.ts"],
          exclude: ["node_modules/**", "src/**/*.spec.ts"],
        },
        output: {
          entryFileNames: "src/pages/[name]/index.js",
          chunkFileNames: isDev
            ? "assets/js/[name].js"
            : "assets/js/[name].[hash].js",
          assetFileNames: (assetInfo) => {
            const sourceFiles = assetInfo.originalFileNames ?? [];
            const isContentStyle = sourceFiles.some((f) =>
              f.endsWith("src/pages/content/style.scss"),
            );
            if (isContentStyle) {
              return `assets/css/contentStyle${cacheInvalidationKey}.chunk.css`;
            }
            const assetName = assetInfo.names?.[0] ?? assetInfo.name ?? "asset";
            const { dir, name: _name } = path.parse(assetName);
            const assetFolder = dir.split("/").at(-1) ?? "";
            const name = assetFolder + firstUpperCase(_name);
            return `assets/[ext]/${name}.chunk.[ext]`;
          },
        },
      },
    },
    test: {
      environment: "jsdom",
      globals: false,
      setupFiles: ["./test-utils/vitest.setup.ts"],
    },
  };
});

function firstUpperCase(str: string) {
  const firstAlphabet = new RegExp(/( |^)[a-z]/, "g");
  return str.toLowerCase().replace(firstAlphabet, (L) => L.toUpperCase());
}

let cacheInvalidationKey: string = generateKey();
function regenerateCacheInvalidationKey() {
  cacheInvalidationKey = generateKey();
  return cacheInvalidationKey;
}

function generateKey(): string {
  return `${(Date.now() / 100).toFixed()}`;
}
