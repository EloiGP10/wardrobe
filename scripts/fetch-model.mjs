import { createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const dest = process.env.MATTING_MODEL || resolve("models", "isnet-general-use.onnx");
const url = process.env.MATTING_MODEL_URL || "https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx";

if (existsSync(dest) && statSync(dest).size > 1_000_000) {
  console.log("[fetch-model] model already present, skipping");
  process.exit(0);
}

mkdirSync(dirname(dest), { recursive: true });
console.log(`[fetch-model] downloading ${url}`);
const sep = url.includes("?") ? "&" : "?";
const busted = `${url}${sep}cb=${Date.now()}`;
const res = await fetch(busted);
if (!res.ok || !res.body) {
  console.warn(`[fetch-model] cache-busted download failed (${res.status}), retrying clean URL`);
  const retry = await fetch(url);
  if (!retry.ok || !retry.body) throw new Error(`download failed: ${retry.status}`);
  await pipeline(Readable.fromWeb(retry.body), createWriteStream(dest));
} else {
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}
if (!statSync(dest).size) throw new Error("downloaded file is empty");
console.log(`[fetch-model] saved ${dest}`);