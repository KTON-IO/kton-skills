// Bundles src/main.ts into one file the skill runs with plain `node`, nothing
// to install. Run again after any change; CI checks the committed bundle
// matches (pins.json keeps its SHA-256).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const out = "kton/scripts/kton.mjs";

// @ton/crypto as the three functions @ton/core uses (scripts/ton-crypto-slim.cjs).
const slimCrypto = {
  name: "slim-ton-crypto",
  setup(builder) {
    builder.onResolve({ filter: /^@ton\/crypto$/ }, () => ({
      path: fileURLToPath(new URL("./ton-crypto-slim.cjs", import.meta.url)),
    }));
  },
};
await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: out,
  legalComments: "eof",
  plugins: [slimCrypto],
  banner: {
    js: "// KTON skill script, built from src/ by scripts/build.mjs. Do not edit.\n// Node's deprecation notices (from bundled libraries) would mix into the output the agent reads.\nprocess.noDeprecation = true;\nimport { createRequire as __kton_require } from 'node:module'; const require = __kton_require(import.meta.url);",
  },
});
const hash = createHash("sha256").update(readFileSync(out)).digest("hex");
const pins = JSON.parse(readFileSync("pins.json", "utf8"));
pins.bundle = { file: out, sha256: hash };
writeFileSync("pins.json", `${JSON.stringify(pins, null, 2)}\n`);
console.log(out, hash);
