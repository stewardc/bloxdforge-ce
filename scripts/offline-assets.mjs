// Downloads every remote file referenced by the workshop exports (data/builds.json,
// data/scripts.json, data/texturepacks.json) into data/assets/, so the workshop keeps
// working after the original hosts go away. lib/workshop-data.ts swaps in the local
// copies via data/assets/manifest.json.
//
// Requests are made one at a time and spaced out so the whole run takes roughly
// --hours (default 12). Hosts are interleaved, so each one sees far less than the
// overall rate. 429/503 responses back off and honour Retry-After.
//
// Resumable: re-running skips anything already downloaded and anything that came
// back 401/403/404/410 (pass --retry-failed to try those again).
//
// --only / --skip (repeatable) limit the run to hosts containing the given text;
// --limit N stops after N files (handy for a quick test).
//
//   node scripts/offline-assets.mjs [--hours 12] [--only storage.tally.so] [--skip huggingface.co]
//                                   [--limit N] [--retry-failed] [--dry-run]
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    hours: { type: "string", default: "12" },
    "retry-failed": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    limit: { type: "string" },
    only: { type: "string", multiple: true, default: [] },
    skip: { type: "string", multiple: true, default: [] },
  },
});

const root = path.resolve(import.meta.dirname, "..");
const dataDir = path.join(root, "data");
const assetsDir = path.join(dataDir, "assets");
const manifestPath = path.join(assetsDir, "manifest.json");

const SOURCES = {
  "builds.json": ["url", "img"],
  "scripts.json": ["img"],
  "texturepacks.json": ["file", "img"],
};
const PERMANENT_FAILURES = new Set([401, 403, 404, 410]);
const MAX_ATTEMPTS = 3;
const MIN_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const EXT_BY_TYPE = {
  "image/webp": ".webp", "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif",
  "image/avif": ".avif", "application/zip": ".zip", "application/x-zip-compressed": ".zip",
};

const urls = new Set();
for (const [file, fields] of Object.entries(SOURCES)) {
  const src = path.join(dataDir, file);
  if (!existsSync(src)) {
    console.warn(`Skipping missing data/${file}`);
    continue;
  }
  for (const entry of JSON.parse(readFileSync(src, "utf-8"))) {
    const item = entry.itemData ?? entry;
    for (const field of fields) {
      if (typeof item[field] === "string" && /^https?:\/\//.test(item[field])) urls.add(item[field]);
    }
  }
}

mkdirSync(assetsDir, { recursive: true });
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf-8")) : {};
let dirty = 0;
function saveManifest() {
  writeFileSync(`${manifestPath}.tmp`, JSON.stringify(manifest, null, 1));
  renameSync(`${manifestPath}.tmp`, manifestPath);
  dirty = 0;
}
process.on("SIGINT", () => {
  saveManifest();
  console.log("\nInterrupted; progress saved. Re-run to resume.");
  process.exit(130);
});

const pending = [...urls].filter((url) => {
  const host = new URL(url).host;
  if (args.only.length && !args.only.some((h) => host.includes(h))) return false;
  if (args.skip.some((h) => host.includes(h))) return false;
  const entry = manifest[url];
  if (entry?.file && existsSync(path.join(assetsDir, entry.file))) return false;
  if (entry?.status && PERMANENT_FAILURES.has(entry.status) && !args["retry-failed"]) return false;
  return true;
});

// Round-robin across hosts so no single server gets consecutive requests.
const byHost = new Map();
for (const url of pending) {
  const host = new URL(url).host;
  if (!byHost.has(host)) byHost.set(host, []);
  byHost.get(host).push(url);
}
const queue = [];
for (let i = 0; queue.length < pending.length; i++) {
  for (const list of byHost.values()) if (i < list.length) queue.push(list[i]);
}

if (args.limit) queue.length = Math.min(queue.length, Number(args.limit));

const deadline = Date.now() + Number(args.hours) * 3600 * 1000;
console.log(`${urls.size} referenced, ${pending.length} to fetch across ${byHost.size} hosts, target ~${args.hours}h`);
for (const [host, list] of byHost) console.log(`  ${host}: ${list.length}`);
if (args["dry-run"]) process.exit(0);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function localName(url, contentType) {
  const parsed = new URL(url);
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 20);
  let ext = path.extname(decodeURIComponent(parsed.pathname)).toLowerCase();
  if (!/^\.[a-z0-9]{1,12}$/.test(ext) || ext === ".php") ext = EXT_BY_TYPE[contentType] ?? "";
  return path.join(parsed.host, `${hash}${ext}`);
}

async function download(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "BloxdForge-CE archiver (one request at a time)" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    await res.body?.cancel();
    const retryAfter = Number(res.headers.get("retry-after"));
    return { status: res.status, retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : 0 };
  }
  const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim();
  // A signed link that has expired can come back as a 200 HTML page.
  if (contentType === "text/html") {
    await res.body?.cancel();
    return { status: "html" };
  }
  const file = localName(url, contentType);
  const dest = path.join(assetsDir, file);
  mkdirSync(path.dirname(dest), { recursive: true });
  try {
    await pipeline(Readable.fromWeb(res.body), createWriteStream(`${dest}.part`));
  } catch (err) {
    rmSync(`${dest}.part`, { force: true });
    throw err;
  }
  renameSync(`${dest}.part`, dest);
  return { status: res.status, file, contentType };
}

let done = 0;
let failed = 0;
let backoffMs = 0;
for (let i = 0; i < queue.length; i++) {
  const url = queue[i];
  const started = Date.now();
  const attempts = (manifest[url]?.attempts ?? 0) + 1;
  let result;
  try {
    result = await download(url);
  } catch (err) {
    result = { status: err.name === "TimeoutError" ? "timeout" : "error", error: String(err.message ?? err) };
  }

  if (result.file) {
    manifest[url] = { file: result.file, contentType: result.contentType };
    done++;
    backoffMs = 0;
  } else if (result.status === 429 || result.status === 503) {
    // The server asked us to slow down: wait, then try this URL again.
    backoffMs = Math.max(result.retryAfterMs, Math.min(Math.max(backoffMs * 2, 30_000), 15 * 60_000));
    console.warn(`${result.status} from ${new URL(url).host}; backing off ${Math.round(backoffMs / 1000)}s`);
    if (attempts < MAX_ATTEMPTS * 2) queue.push(url);
    manifest[url] = { status: result.status, attempts };
    failed++;
  } else {
    manifest[url] = { status: result.status, attempts, ...(result.error && { error: result.error }) };
    if (!PERMANENT_FAILURES.has(result.status) && attempts < MAX_ATTEMPTS) queue.push(url);
    failed++;
  }
  if (++dirty >= 10) saveManifest();

  const remaining = queue.length - i - 1;
  if (remaining === 0) break;
  if (i % 25 === 0 || !result.file) {
    const eta = new Date(Date.now() + Math.max(deadline - Date.now(), 0)).toLocaleTimeString();
    console.log(`[${i + 1}/${queue.length}] ok=${done} failed=${failed} last=${result.status} ${result.file ?? url.slice(0, 80)} (target end ${eta})`);
  }
  // Spread what's left evenly over the time left, with jitter.
  const spacing = Math.max((deadline - Date.now()) / remaining, MIN_DELAY_MS);
  const elapsed = Date.now() - started;
  await sleep(Math.max(spacing * (0.75 + Math.random() * 0.5) - elapsed, 0) + backoffMs);
}
saveManifest();
console.log(`Done: ${done} downloaded, ${failed} failed this run. Manifest: ${path.relative(root, manifestPath)}`);
