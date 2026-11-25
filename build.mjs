import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/web", { recursive: true });
await build({
  entryPoints: ["src/main.ts"], outfile: "dist/server.mjs", bundle: true, platform: "node", format: "esm", target: "node24", minify: false, legalComments: "linked",
  // CommonJS dependencies inside an ESM bundle need a require().
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url); import { fileURLToPath as __f } from 'node:url'; import { dirname as __d } from 'node:path'; const __filename = __f(import.meta.url); const __dirname = __d(__filename);" },
});
await build({
  entryPoints: { app: "web/src/main.tsx", style: "web/src/style.css" }, outdir: "dist/web", bundle: true, format: "esm", target: "es2022", minify: true, sourcemap: false,
  jsx: "automatic", jsxImportSource: "preact",
});
cpSync("web/public", "dist/web", { recursive: true });
cpSync("web/index.html", "dist/web/index.html");
cpSync("web/sw.js", "dist/web/sw.js");
console.log("built");
