import { createServer as createHttpServer } from "node:http";
import { readFileSync, existsSync, statSync, mkdirSync, copyFileSync, unlinkSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const STORAGE_BUCKET = process.env.WARDROBE_STORAGE_BUCKET || "wardrobe";
const IS_PROD = process.env.NODE_ENV === "production";
const PORT = parseInt(process.env.PORT || "3000", 10);
const DIST_DIR = resolve(process.env.DIST_DIR || "dist");

let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  console.log("[wardrobe] Supabase connected");
} else {
  console.log("[wardrobe] Supabase not configured — using filesystem fallback");
}

const DATA_DIR = resolve(process.cwd(), "data");
const UPLOAD_DIR = resolve(DATA_DIR, "imported");
if (!existsSync(UPLOAD_DIR)) { mkdirSync(UPLOAD_DIR, { recursive: true }); }

// ─── JSON helpers ─────────────────────────────────────────────────────────────

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
}

async function parseBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

// ─── Supabase helpers ──────────────────────────────────────────────────────────

async function sbQuery(table, opts = {}) {
  if (!supabase) throw new Error("No Supabase");
  let q = supabase.from(table).select(opts.select || "*");
  if (opts.eq) { const [[k, v]] = Object.entries(opts.eq); q = q.eq(k, v); }
  if (opts.order) q = q.order(opts.order.col, { ascending: opts.order.asc });
  if (opts.limit) q = q.limit(opts.limit);
  const { data, error } = await q;
  if (error) throw error;
  return opts.single ? (data?.[0] ?? null) : (data || []);
}

async function sbUpsert(table, row) {
  if (!supabase) throw new Error("No Supabase");
  const { data, error } = await supabase.from(table).upsert(row, { onConflict: "id" }).select().single();
  if (error) throw error;
  return data;
}

async function sbDelete(table, eq) {
  if (!supabase) throw new Error("No Supabase");
  const { error } = await supabase.from(table).delete().eq(...Object.entries(eq)[0]);
  if (error) throw error;
}

// ─── Filesystem helpers ───────────────────────────────────────────────────────

async function loadLibraryFile() {
  const file = resolve(DATA_DIR, "library.json");
  if (!existsSync(file)) return [];
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return []; }
}

async function saveLibraryFile(records) {
  const { mkdirSync: mk, writeFileSync: wf, renameSync: rn, unlinkSync: ul } = await import("node:fs");
  mk(resolve(DATA_DIR), { recursive: true });
  const tmp = resolve(DATA_DIR, `library.json.${Date.now()}.tmp`);
  wf(tmp, JSON.stringify(records, null, 2) + "\n");
  try { rn(tmp, resolve(DATA_DIR, "library.json")); } catch { copyFileSync(tmp, resolve(DATA_DIR, "library.json")); ul(tmp, { force: true }); }
}

// ─── Outfit rules ─────────────────────────────────────────────────────────────

const COMPATIBLE = {
  upperbody: ["lowerbody", "shoes", "accessories_up"],
  wholebody_up: ["shoes", "accessories_up"],
  lowerbody: ["upperbody", "wholebody_up", "shoes", "accessories_up"],
  accessories_up: ["upperbody", "wholebody_up", "lowerbody"],
  shoes: ["upperbody", "wholebody_up", "lowerbody"],
};

function colorDist(a, b) {
  if (!a || !b) return Infinity;
  const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const [ra, ga, ba] = hex(a), [rb, gb, bb] = hex(b);
  return Math.sqrt((ra - rb) ** 2 + (ga - gb) ** 2 + (ba - bb) ** 2);
}

function getFormality(tags = []) {
  const t = (tags || []).map((s) => s.toLowerCase());
  if (t.some((s) => ["formal", "dress", "suit", "office"].includes(s))) return "formal";
  if (t.some((s) => ["casual", "comfy", "relaxed"].includes(s))) return "casual";
  if (t.some((s) => ["sport", "gym", "running"].includes(s))) return "sport";
  return "neutral";
}

function scorePair(a, b) {
  let s = 0;
  if (COMPATIBLE[a.part]?.includes(b.part)) s += 10;
  if (a.part === b.part) return -100;
  if (colorDist(a.color, b.color) < 80) s += 5; else if (colorDist(a.color, b.color) < 200) s += 2;
  if (getFormality(a.tags) === getFormality(b.tags)) s += 3;
  if ((a.tags || []).some((t) => (b.tags || []).includes(t))) s += 2;
  return s;
}

// ─── API Handlers ──────────────────────────────────────────────────────────────

async function apiGetGarments(req, res) {
  if (supabase) {
    const data = await sbQuery("garments", { order: { col: "created_at", asc: false } });
    return json(res, 200, (data || []).map((g) => ({
      id: g.id, name: g.name, part: g.part, color: g.color,
      secondaryColor: g.secondary_color, palette: g.palette || [], tags: g.tags || [],
      image: `/api/library/${g.id}-garment.png`,
      thumbnail: `/api/library/${g.id}-garment.png`,
      modeledImage: g.modeled_image_path ? `/api/library/${g.id}-modeled.png` : null,
    })));
  }
  json(res, 200, await loadLibraryFile());
}

async function apiGetGarment(req, res, id) {
  if (supabase) {
    const g = await sbQuery("garments", { eq: { id }, single: true });
    if (!g) return json(res, 404, { error: "Not found" });
    return json(res, 200, { id: g.id, name: g.name, part: g.part, color: g.color,
      secondaryColor: g.secondary_color, palette: g.palette || [], tags: g.tags || [],
      image: `/api/library/${g.id}-garment.png`,
      thumbnail: `/api/library/${g.id}-garment.png`,
      modeledImage: g.modeled_image_path ? `/api/library/${g.id}-modeled.png` : null,
    });
  }
  const recs = await loadLibraryFile();
  const g = recs.find((r) => r.id === id);
  if (!g) return json(res, 404, { error: "Not found" });
  json(res, 200, g);
}

async function apiUpdateGarment(req, res, id) {
  const input = await parseBody(req);
  if (supabase) {
    await sbUpsert("garments", {
      id, name: (input.name || "New piece").trim().slice(0, 120),
      part: input.part || "upperbody", color: input.color || "#d8d0c2",
      secondary_color: input.secondaryColor || null,
      palette: Array.isArray(input.palette) ? input.palette : [],
      tags: Array.isArray(input.tags) ? input.tags : [],
    });
    const g = await sbQuery("garments", { eq: { id }, single: true });
    return json(res, 200, { id: g.id, name: g.name, part: g.part, color: g.color,
      secondaryColor: g.secondary_color, palette: g.palette || [], tags: g.tags || [],
      image: `/api/library/${g.id}-garment.png`,
      thumbnail: `/api/library/${g.id}-garment.png`,
      modeledImage: g.modeled_image_path ? `/api/library/${g.id}-modeled.png` : null,
    });
  }
  const recs = await loadLibraryFile();
  const idx = recs.findIndex((r) => r.id === id);
  if (idx < 0) return json(res, 404, { error: "Not found" });
  recs[idx] = { ...recs[idx], ...input };
  await saveLibraryFile(recs);
  json(res, 200, recs[idx]);
}

async function apiDeleteGarment(req, res, id) {
  if (supabase) {
    await sbDelete("garments", { id });
  } else {
    const recs = await loadLibraryFile();
    const next = recs.filter((r) => r.id !== id);
    if (next.length === recs.length) return json(res, 404, { error: "Not found" });
    await saveLibraryFile(next);
  }
  try { unlinkSync(resolve(UPLOAD_DIR, `${id}-garment.png`)); } catch {}
  try { unlinkSync(resolve(UPLOAD_DIR, `${id}-modeled.png`)); } catch {}
  json(res, 200, { deleted: true, id });
}

async function apiGetOutfits(req, res) {
  if (!supabase) return json(res, 200, []);
  const outfits = await sbQuery("outfits", { order: { col: "created_at", asc: false } });
  const result = await Promise.all((outfits || []).map(async (o) => {
    const items = await sbQuery("outfit_items", { eq: { outfit_id: o.id }, order: { col: "position", asc: true } });
    return { id: o.id, name: o.name, occasion: o.occasion, season: o.season,
      notes: o.notes, garmentIds: (items || []).map((i) => i.garment_id),
      createdAt: o.created_at, updatedAt: o.updated_at };
  }));
  json(res, 200, result);
}

async function apiCreateOutfit(req, res) {
  if (!supabase) return json(res, 501, { error: "Supabase required" });
  const input = await parseBody(req);
  const { data: outfit, error } = await supabase
    .from("outfits")
    .insert({ name: input.name || "New outfit", occasion: input.occasion || null, season: input.season || null, notes: input.notes || null })
    .select().single();
  if (error) throw error;
  if (Array.isArray(input.garmentIds) && input.garmentIds.length) {
    await supabase.from("outfit_items").insert(input.garmentIds.map((gid, i) => ({ outfit_id: outfit.id, garment_id: gid, position: i })));
  }
  json(res, 201, { id: outfit.id, name: outfit.name, occasion: outfit.occasion, season: outfit.season,
    notes: outfit.notes, garmentIds: input.garmentIds || [], createdAt: outfit.created_at, updatedAt: outfit.updated_at });
}

async function apiUpdateOutfit(req, res, id) {
  if (!supabase) return json(res, 501, { error: "Supabase required" });
  const input = await parseBody(req);
  await supabase.from("outfits").update({ name: input.name, occasion: input.occasion || null, season: input.season || null, notes: input.notes || null }).eq("id", id);
  if ("garmentIds" in input) {
    await supabase.from("outfit_items").delete().eq("outfit_id", id);
    if (Array.isArray(input.garmentIds) && input.garmentIds.length) {
      await supabase.from("outfit_items").insert(input.garmentIds.map((gid, i) => ({ outfit_id: id, garment_id: gid, position: i })));
    }
  }
  const updated = await sbQuery("outfits", { eq: { id }, single: true });
  const items = await sbQuery("outfit_items", { eq: { outfit_id: id }, order: { col: "position", asc: true } });
  json(res, 200, { id: updated.id, name: updated.name, occasion: updated.occasion, season: updated.season,
    notes: updated.notes, garmentIds: (items || []).map((i) => i.garment_id), createdAt: updated.created_at, updatedAt: updated.updated_at });
}

async function apiDeleteOutfit(req, res, id) {
  if (!supabase) return json(res, 501, { error: "Supabase required" });
  await sbDelete("outfits", { id });
  json(res, 200, { deleted: true, id });
}

async function apiSuggestOutfits(req, res) {
  if (!supabase) return json(res, 200, { outfits: [], message: "Configure Supabase for suggestions" });
  const garments = await sbQuery("garments", { order: { col: "created_at", asc: false } });
  if (!garments?.length) return json(res, 200, { outfits: [], message: "Add garments first" });

  const tops = garments.filter((g) => g.part === "upperbody" || g.part === "wholebody_up");
  const bottoms = garments.filter((g) => g.part === "lowerbody");
  const shoes = garments.filter((g) => g.part === "shoes");
  const accs = garments.filter((g) => g.part === "accessories_up");

  const suggestions = [];
  for (const top of tops.slice(0, 5)) {
    for (const bottom of bottoms.slice(0, 5)) {
      const base = scorePair(top, bottom);
      if (base < 0) continue;

      let bestShoes = null, bestShoesScore = -100;
      for (const shoe of shoes.slice(0, 3)) {
        const s = scorePair(top, shoe) + scorePair(bottom, shoe);
        if (s > bestShoesScore) { bestShoesScore = s; bestShoes = shoe; }
      }

      let bestAcc = null, bestAccScore = -100;
      for (const acc of accs.slice(0, 3)) {
        const s = scorePair(top, acc) + scorePair(bottom, acc);
        if (s > bestAccScore) { bestAccScore = s; bestAcc = acc; }
      }

      const total = base + (bestShoesScore || 0) + (bestAccScore || 0);
      if (total < 5) continue;

      const gs = [top, bottom];
      if (bestShoes) gs.push(bestShoes);
      if (bestAcc) gs.push(bestAcc);

      suggestions.push({ name: `Look with ${top.name}`, occasion: getFormality(top.tags), garmentIds: gs.map((g) => g.id), score: total });
    }
  }

  suggestions.sort((a, b) => b.score - a.score);
  json(res, 200, { outfits: suggestions.slice(0, 8) });
}

async function apiStatus(req, res) {
  json(res, 200, { hasSupabase: Boolean(supabase), hasApiKey: Boolean(process.env.OPENAI_API_KEY?.trim()), ready: Boolean(supabase) });
}

async function serveImage(req, res, filename) {
  const filePath = resolve(UPLOAD_DIR, filename);
  if (!existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Not found" }));
  }
  const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml" }[extname(filename).toLowerCase()] || "image/png";
  res.writeHead(200, { "Content-Type": mime, "Cache-Control": "public, max-age=31536000, immutable" });
  res.end(readFileSync(filePath));
}

// ─── Route handler ───────────────────────────────────────────────────────────

async function handleApi(req, res) {
  const url = new URL(req.url, "http://localhost");
  const { pathname } = url;

  try {
    if (req.method === "GET" && pathname === "/api/status") { await apiStatus(req, res); return true; }
    if (req.method === "GET" && pathname === "/api/garments") { await apiGetGarments(req, res); return true; }
    if (req.method === "GET" && pathname === "/api/outfits") { await apiGetOutfits(req, res); return true; }
    if (req.method === "GET" && pathname === "/api/outfits/suggest") { await apiSuggestOutfits(req, res); return true; }

    const garmentMatch = pathname.match(/^\/api\/garments\/([^/]+)\/(image|thumb|modeled)$/);
    if (req.method === "GET" && garmentMatch) { await serveImage(req, res, `${garmentMatch[1]}-garment.png`); return true; }

    const gDetail = pathname.match(/^\/api\/garments\/([^/]+)$/);
    if (gDetail) {
      const id = gDetail[1];
      if (req.method === "GET") { await apiGetGarment(req, res, id); return true; }
      if (req.method === "PATCH") { await apiUpdateGarment(req, res, id); return true; }
      if (req.method === "DELETE") { await apiDeleteGarment(req, res, id); return true; }
    }

    const oDetail = pathname.match(/^\/api\/outfits\/([^/]+)$/);
    if (oDetail) {
      const id = oDetail[1];
      if (req.method === "PATCH") { await apiUpdateOutfit(req, res, id); return true; }
      if (req.method === "DELETE") { await apiDeleteOutfit(req, res, id); return true; }
    }

    if (req.method === "POST" && pathname === "/api/outfits") { await apiCreateOutfit(req, res); return true; }

    const libMatch = pathname.match(/^\/api\/library\/(.+)$/);
    if (req.method === "GET" && libMatch) { await serveImage(req, res, libMatch[1]); return true; }

    return false;
  } catch (err) {
    console.error("[wardrobe]", err.message);
    json(res, err.status || 500, { error: err.status === 404 ? "Not found" : "Internal server error" });
    return true;
  }
}

// ─── Static file server ────────────────────────────────────────────────────────

function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  let filePath = resolve(DIST_DIR, url.pathname.replace(/^\//, ""));

  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = resolve(DIST_DIR, "index.html");
  }

  if (!existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("Not found");
  }

  const mime = {
    ".html": "text/html", ".js": "application/javascript",
    ".css": "text/css", ".json": "application/json",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".webp": "image/webp", ".svg": "image/svg+xml", ".woff2": "font/woff2",
    ".ico": "image/x-icon",
  }[extname(filePath).toLowerCase()] || "application/octet-stream";

  res.writeHead(200, { "Content-Type": mime, "Cache-Control": "public, max-age=86400" });
  res.end(readFileSync(filePath));
}

// ─── Main server ────────────────────────────────────────────────────────────────

const server = createHttpServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname.startsWith("/api/")) {
    if (await handleApi(req, res)) return;
  }

  serveStatic(req, res);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[wardrobe] http://localhost:${PORT} (${IS_PROD ? "prod" : "dev"})`);
});

process.on("SIGTERM", () => { server.close(); });
process.on("SIGINT", () => { server.close(); });
