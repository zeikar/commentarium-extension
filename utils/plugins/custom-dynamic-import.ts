import type { PluginOption } from "vite";

export default function customDynamicImport(): PluginOption {
  return {
    name: "custom-dynamic-import",
    renderDynamicImport() {
      // Wrap as an IIFE expression — not a block — so that when Vite's
      // __vitePreload helper wraps this in `() => <expr>`, the import
      // promise is returned. A block body would discard the promise and
      // cause `loader().catch(...)` to throw `Cannot read properties of
      // undefined (reading 'catch')` at content-script load time.
      return {
        left: "((path) => import(path))(",
        right: ")",
      };
    },
  };
}
