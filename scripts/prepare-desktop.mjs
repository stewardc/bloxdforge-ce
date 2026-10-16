// Assembles the Next.js standalone server into dist-server/ so electron-builder
// can ship it as an extra resource. Run after `next build`.
import { cpSync, existsSync, rmSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const standalone = path.join(root, ".next", "standalone");
const out = path.join(root, "dist-server");

if (!existsSync(path.join(standalone, "server.js"))) {
  console.error("Missing .next/standalone/server.js. Run `npm run build` first.");
  process.exit(1);
}
for (const dir of ["lib", "vb", "textures", "environment", "fonts"]) {
  if (!existsSync(path.join(root, "public", dir))) {
    console.error(`Missing public/${dir}. Run \`npm run unpack-assets\` first.`);
    process.exit(1);
  }
}

if (!existsSync(path.join(root, "data", "textures.txt"))) {
  console.error("Missing data/textures.txt. Run `npm run unpack-assets` first.");
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
cpSync(standalone, out, { recursive: true, verbatimSymlinks: true });
cpSync(path.join(root, ".next", "static"), path.join(out, ".next", "static"), { recursive: true });
cpSync(path.join(root, "public"), path.join(out, "public"), {
  recursive: true,
  filter: (src) => !src.endsWith(".7z"),
});
console.log(`Prepared ${path.relative(root, out)}/`);
