import { existsSync, createWriteStream, mkdirSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";

const MODEL_URL = process.env.MATTING_MODEL_URL || "https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx";
const MODEL_SIZE = 1024;
const ORT_DYNAMIC_IMPORT = () => import("onnxruntime-node");

let sessionP = null;

function modelPath() {
  return process.env.MATTING_MODEL || resolve(process.cwd(), "models", "isnet-general-use.onnx");
}

async function ensureModel() {
  const p = modelPath();
  if (existsSync(p) && statSync(p).size > 1_000_000) return p;
  mkdirSync(dirname(p), { recursive: true });
  console.log("[matting] downloading ISNet model...");
  const res = await fetch(MODEL_URL);
  if (!res.ok || !res.body) throw new Error(`model download failed: ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(p));
  if (!statSync(p).size) throw new Error("model download empty");
  return p;
}

async function getSession() {
  if (sessionP) return sessionP;
  sessionP = (async () => {
    const ort = await ORT_DYNAMIC_IMPORT();
    const path = await ensureModel();
    return ort.InferenceSession.create(path, { executionProviders: ["cpu"] });
  })();
  return sessionP;
}

// ─── AI matting (ISNet via onnxruntime) ───────────────────────────────────────

async function segmentIsnet(buffer) {
  if (process.env.MATTING_ENGINE === "native") throw new Error("AI matting disabled by MATTING_ENGINE=native");
  const ort = await ORT_DYNAMIC_IMPORT();
  const session = await getSession();

  const { data, info } = await sharp(buffer)
    .rotate()
    .resize(MODEL_SIZE, MODEL_SIZE, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const px = MODEL_SIZE * MODEL_SIZE;
  const input = new Float32Array(3 * px);
  for (let i = 0; i < px; i++) {
    input[i] = data[i * 3] / 255;
    input[px + i] = data[i * 3 + 1] / 255;
    input[2 * px + i] = data[i * 3 + 2] / 255;
  }

  const feed = { [session.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, MODEL_SIZE, MODEL_SIZE]) };
  const out = await session.run(feed);
  const maskName = session.outputNames[0];
  const prob = out[maskName]?.data || (out["266"]?.data) || null;
  if (!prob) throw new Error("no probability output");

  const alphaSmall = Buffer.alloc(MODEL_SIZE * MODEL_SIZE);
  for (let i = 0; i < MODEL_SIZE * MODEL_SIZE; i++) {
    alphaSmall[i] = Math.max(0, Math.min(255, Math.round(prob[i] * 255)));
  }

  return composeAlpha(buffer, alphaSmall, MODEL_SIZE, MODEL_SIZE);
}

// ─── Native flood-fill (white-background cut) ─────────────────────────────────

async function removeBackgroundFloodFill(buffer) {
  const image = sharp(buffer);
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) return buffer;

  const { data, info } = await image
    .rotate()
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const tolerance = 40;
  const bgSet = new Uint8Array(w * h);
  const queue = [];

  const isWhite = (i) => {
    const r = data[i * 3];
    const g = data[i * 3 + 1];
    const b = data[i * 3 + 2];
    return Math.max(r, g, b) - Math.min(r, g, b) <= tolerance && r >= 255 - tolerance;
  };

  for (let x = 0; x < w; x++) {
    if (isWhite(x)) { bgSet[x] = 1; queue.push(x); }
    if (isWhite((h - 1) * w + x)) { bgSet[(h - 1) * w + x] = 1; queue.push((h - 1) * w + x); }
  }
  for (let y = 0; y < h; y++) {
    if (isWhite(y * w)) { bgSet[y * w] = 1; queue.push(y * w); }
    if (isWhite(y * w + w - 1)) { bgSet[y * w + w - 1] = 1; queue.push(y * w + w - 1); }
  }

  const dirs = [1, -1, w, -w];
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi];
    for (const d of dirs) {
      const n = cur + d;
      if (n < 0 || n >= bgSet.length) continue;
      if (bgSet[n]) continue;
      const nx = n % w;
      if (Math.abs(nx - (cur % w)) > 1) continue;
      if (isWhite(n)) { bgSet[n] = 1; queue.push(n); }
    }
  }

  const feathered = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (bgSet[i]) {
        let nearFg = false;
        for (let dy = -1; dy <= 1 && !nearFg; dy++) {
          for (let dx = -1; dx <= 1 && !nearFg; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            if (!bgSet[ny * w + nx]) nearFg = true;
          }
        }
        feathered[i] = nearFg ? 128 : 0;
      } else {
        feathered[i] = 255;
      }
    }
  }

  return composeRgbaPng(data, info.width, info.height, feathered);
}

// ─── Shared composition (avoids sharp.joinChannel bug) ────────────────────────

async function composeAlpha(buffer, alphaSmall, sw, sh) {
  const { data, info } = await sharp(buffer).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { data: alphaFull } = await sharp(alphaSmall, { raw: { width: sw, height: sh, channels: 1 } })
    .resize(info.width, info.height)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const alpha = Buffer.alloc(info.width * info.height);
  for (let i = 0; i < info.width * info.height; i++) {
    const a = alphaFull[i];
    alpha[i] = a < 12 ? 0 : a === 255 ? 255 : Math.min(255, a + 8);
  }
  return composeRgbaPng(data, info.width, info.height, alpha);
}

function composeRgbaPng(rgb, w, h, alpha) {
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = rgb[i * 3];
    rgba[i * 4 + 1] = rgb[i * 3 + 1];
    rgba[i * 4 + 2] = rgb[i * 3 + 2];
    rgba[i * 4 + 3] = alpha[i];
  }
  return sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
}

// ─── Public ───────────────────────────────────────────────────────────────────

export async function removeBackground(buffer) {
  try {
    return await segmentIsnet(buffer);
  } catch (err) {
    console.error("[matting][ai] failed, falling back:", err.message);
  }
  return removeBackgroundFloodFill(buffer);
}

export async function inspectAlpha(buffer) {
  const meta = await sharp(buffer).metadata();
  return Boolean(meta.hasAlpha);
}