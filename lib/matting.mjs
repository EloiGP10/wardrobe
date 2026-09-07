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

  const { data: alphaFull } = await sharp(alphaSmall, { raw: { width: MODEL_SIZE, height: MODEL_SIZE, channels: 1 } })
    .resize(info.width, info.height, { kernel: sharp.kernel.lanczos2 })
    .raw()
    .toBuffer({ resolveWithObject: true });

  return finalizeMask(buffer, alphaFull);
}

// ─── Native flood-fill (white-background cut) ─────────────────────────────────

function isWhiteRgb(rgb, i) {
  const r = rgb[i];
  const g = rgb[i + 1];
  const b = rgb[i + 2];
  return Math.max(r, g, b) - Math.min(r, g, b) <= 40 && r >= 215;
}

// Background = white pixels 4-connected to the image border.
function floodFillWhite(rgb, w, h) {
  const bg = new Uint8Array(w * h);
  const queue = [];
  const push = (i) => { if (!bg[i] && isWhiteRgb(rgb, i * 3)) { bg[i] = 1; queue.push(i); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  const dirs = [1, -1, w, -w];
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi];
    const cx = cur % w;
    for (const d of dirs) {
      const n = cur + d;
      if (n < 0 || n >= w * h || bg[n]) continue;
      if (Math.abs((n % w) - cx) > 1) continue;
      if (isWhiteRgb(rgb, n * 3)) { bg[n] = 1; queue.push(n); }
    }
  }
  return bg;
}

async function removeBackgroundFloodFill(buffer) {
  const { data, info } = await readRgb(buffer);
  const bg = floodFillWhite(data, info.width, info.height);
  const alpha = Buffer.alloc(info.width * info.height);
  for (let i = 0; i < info.width * info.height; i++) alpha[i] = bg[i] ? 0 : 255;
  return finalizeMask(buffer, alpha, true);
}

// ─── Shared read / composition ────────────────────────────────────────────────

async function readRgb(buffer) {
  return sharp(buffer).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
}

// Keep the largest connected area(s) of alpha>0; drop small specks (>=3% of the largest).
function keepLargestComponents(alpha, w, h) {
  const N = w * h;
  const label = new Int32Array(N).fill(-1);
  const queue = new Int32Array(N);
  const sizes = [];
  for (let s = 0; s < N; s++) {
    if (!alpha[s] || label[s] !== -1) continue;
    const id = sizes.length;
    let size = 0, head = 0, tail = 0;
    queue[tail++] = s;
    label[s] = id;
    while (head < tail) {
      const c = queue[head++];
      size++;
      const cx = c % w;
      const cy = (c / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = cy + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          if (nx < 0 || nx >= w) continue;
          const nc = ny * w + nx;
          if (alpha[nc] && label[nc] === -1) { label[nc] = id; queue[tail++] = nc; }
        }
      }
    }
    sizes.push(size);
  }
  let max = 0;
  for (const s of sizes) if (s > max) max = s;
  const minKeep = max * 0.03;
  if (!minKeep) return alpha;
  for (let i = 0; i < N; i++) {
    if (alpha[i] && sizes[label[i]] < minKeep) alpha[i] = 0;
  }
  return alpha;
}

// Reclassify flood-filled white regions using the AI mask:
//   - thin full-width bars spanning the frame (webpage chrome) → background
//   - white regions the AI strongly owns (garment body) → protected
//   - everywhere else on the flooded white → background
// Returns a new bg array: 1 = treat as background, 0 = keep.
function classifyFlood(rgb, ai, flood, w, h) {
  const N = w * h;
  const out = new Uint8Array(flood);
  const label = new Int32Array(N).fill(-1);
  const queue = new Int32Array(N);
  const infos = [];
  for (let s = 0; s < N; s++) {
    if (!flood[s] || label[s] !== -1) continue;
    const id = infos.length;
    let head = 0, tail = 0, cnt = 0, aiHi = 0;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    queue[tail++] = s; label[s] = id;
    while (head < tail) {
      const c = queue[head++];
      cnt++;
      const cx = c % w, cy = (c / w) | 0;
      if (ai[c] >= 250) aiHi++;
      if (cx < x0) x0 = cx;
      if (cx > x1) x1 = cx;
      if (cy < y0) y0 = cy;
      if (cy > y1) y1 = cy;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = cy + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          if (nx < 0 || nx >= w) continue;
          const nc = ny * w + nx;
          if (flood[nc] && label[nc] === -1) { label[nc] = id; queue[tail++] = nc; }
        }
      }
    }
    const wFrac = (x1 - x0 + 1) / w;
    const hFrac = (y1 - y0 + 1) / h;
    const aiRatio = cnt ? aiHi / cnt : 0;
    const touchesEdge = y0 <= h * 0.02 || y1 >= h * 0.98 || x0 <= w * 0.02 || x1 >= w * 0.98;
    const chrome = aiRatio > 0.3 && wFrac >= 0.8 && hFrac < 0.45 && touchesEdge;
    const keep = !chrome && aiRatio > 0.1;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const c = y * w + x;
        if (label[c] !== id) continue;
        out[c] = keep ? 0 : 1;
      }
    }
  }
  return out;
}

// Remove the white fringe: for semi-transparent edge pixels blended against a
// white backdrop, recover the true foreground color by decoding the src-over
// equation. Near-black results mean the pixel was mostly backdrop → drop it.
function defringe(rgb, alpha, w, h) {
  const N = w * h;
  let border = 0, white = 0;
  for (let x = 0; x < w; x++) {
    border += 2;
    if (isWhiteRgb(rgb, x * 3)) white++;
    if (isWhiteRgb(rgb, ((h - 1) * w + x) * 3)) white++;
  }
  for (let y = 0; y < h; y++) {
    border += 2;
    if (isWhiteRgb(rgb, y * w * 3)) white++;
    if (isWhiteRgb(rgb, (y * w + w - 1) * 3)) white++;
  }
  if (!border || white / border < 0.5) return alpha;
  for (let i = 0; i < N; i++) {
    const a = alpha[i];
    if (a === 0 || a === 255) continue;
    const f = a / 255;
    const un = (ch) => {
      const v = Math.round(255 - (255 - ch) / f);
      return v < 0 ? 0 : v > 255 ? 255 : v;
    };
    const r = un(rgb[i * 3]);
    const g = un(rgb[i * 3 + 1]);
    const b = un(rgb[i * 3 + 2]);
    if (r < 28 && g < 28 && b < 28) {
      alpha[i] = 0;
    } else {
      rgb[i * 3] = r;
      rgb[i * 3 + 1] = g;
      rgb[i * 3 + 2] = b;
    }
  }
  return alpha;
}

// Crop to the opaque content with a small margin.
function cropRgba(rgb, alpha, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1, n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (alpha[y * w + x] > 0) {
        n++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (!n || n < w * h * 0.01) return null;
  const mw = Math.max(1, Math.round((x1 - x0 + 1) * 0.02));
  const mh = Math.max(1, Math.round((y1 - y0 + 1) * 0.02));
  x0 = Math.max(0, x0 - mw); y0 = Math.max(0, y0 - mh);
  x1 = Math.min(w - 1, x1 + mw); y1 = Math.min(h - 1, y1 + mh);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const rgba = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const si = (y0 + y) * w + (x0 + x);
      const di = (y * cw + x) * 4;
      rgba[di] = rgb[si * 3];
      rgba[di + 1] = rgb[si * 3 + 1];
      rgba[di + 2] = rgb[si * 3 + 2];
      rgba[di + 3] = alpha[si];
    }
  }
  return { rgba, cw, ch };
}

// ─── Final compositing ────────────────────────────────────────────────────────

async function finalizeMask(buffer, alphaAi, skipChrome = false) {
  const { data: rgb, info } = await readRgb(buffer);
  const w = info.width, h = info.height, N = w * h;

  let alpha = Buffer.alloc(N);
  for (let i = 0; i < N; i++) {
    const a = alphaAi[i];
    alpha[i] = a >= 250 ? 255 : a < 40 ? 0 : a;
  }
  alpha = keepLargestComponents(alpha, w, h);

  if (!skipChrome) {
    const flood = floodFillWhite(rgb, w, h);
    const bg = classifyFlood(rgb, alphaAi, flood, w, h);
    for (let i = 0; i < N; i++) {
      if (bg[i]) alpha[i] = 0;
    }
  }

  alpha = defringe(rgb, alpha, w, h);

  const cropped = cropRgba(rgb, alpha, w, h);
  if (cropped) {
    return sharp(cropped.rgba, { raw: { width: cropped.cw, height: cropped.ch, channels: 4 } })
      .png({ compressionLevel: 9 })
      .toBuffer();
  }
  return sharp(rgb, { raw: { width: w, height: h, channels: 3 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
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

// Temporary diagnostic: replicate the stages and return per-stage stats.
export async function debugMask(buffer, alphaAiFull) {
  const { data: rgb, info } = await readRgb(buffer);
  const w = info.width, h = info.height, N = w * h;
  let alpha = Buffer.alloc(N);
  for (let i = 0; i < N; i++) {
    const a = alphaAiFull[i];
    alpha[i] = a >= 250 ? 255 : a < 40 ? 0 : a;
  }
  const stats = (tag, al) => {
    let op = 0, se = 0;
    for (let i = 0; i < N; i++) { if (al[i]) { al[i] === 255 ? op++ : se++; } }
    return `${tag} op${(op / N * 100).toFixed(1)}% semi${(se / N * 100).toFixed(2)}%`;
  };
  const out = [stats("threshold", alpha)];
  keepLargestComponents(alpha, w, h);
  out.push(stats("keepLargest", alpha));
  const flood = floodFillWhite(rgb, w, h);
  out.push("flood%: " + (Array.prototype.reduce.call(flood, (a, v) => a + v, 0) / N * 100).toFixed(1));
  const bg = classifyFlood(rgb, alphaAiFull, flood, w, h);
  for (let i = 0; i < N; i++) if (bg[i]) alpha[i] = 0;
  out.push(stats("floodok", alpha));
  const aft = Buffer.from(alpha);
  defringe(rgb, alpha, w, h);
  out.push(stats("defringe", alpha));
  // bbox
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (alpha[y * w + x] > 0) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  out.push(`bbox ${x1 >= 0 ? ((x1 - x0) / w * 100).toFixed(0) + "x" + ((y1 - y0) / h * 100).toFixed(0) + "%" : "empty"}`);
  return out.join("\n");
}