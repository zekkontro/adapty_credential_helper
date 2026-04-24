// Bundles dist/ into dist/adapty-credential-helper-v{version}.zip for Chrome
// Web Store upload. No external copy step — this repo is standalone.

import {
  createWriteStream,
  existsSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import archiver from "archiver";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const distDir = resolve(root, "dist");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const zipName = `adapty-credential-helper-v${pkg.version}.zip`;
const outPath = resolve(distDir, zipName);

if (!existsSync(distDir)) {
  console.error("dist/ not found — run `npm run build` first.");
  process.exit(1);
}

if (existsSync(outPath)) unlinkSync(outPath);

await new Promise((resolvePromise, rejectPromise) => {
  const output = createWriteStream(outPath);
  const archive = archiver("zip", { zlib: { level: 9 } });

  output.on("close", () => {
    const size = archive.pointer();
    console.log(
      `packaged ${relative(root, outPath)} (${(size / 1024).toFixed(1)} kB)`
    );
    resolvePromise();
  });
  archive.on("warning", (err) => {
    if (err.code !== "ENOENT") rejectPromise(err);
  });
  archive.on("error", rejectPromise);

  archive.pipe(output);
  archive.glob("**/*", {
    cwd: distDir,
    ignore: ["*.zip", "*.map"],
  });
  archive.finalize();
});
