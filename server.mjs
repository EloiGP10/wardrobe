import { createServer as createHttpServer } from "node:http";
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, extname } from "path";
import pg from "pg";
import dotenv from "dotenv";
import sharp from "sharp";

import { randomUUID } from "node:crypto";
import { removeBackground } from "./lib/matting.mjs";

dotenv.config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const DATABASE_URL = process.env.DATABASE_URL || "";
const PORT = parseInt(process.env.PORT || "3000", 10);
const DIST_DIR = resolve(process.env.DIST_DIR || "dist");
const DATA_DIR = resolve(process.cwd(), "data");
const UPLOAD_DIR = resolve(DATA_DIR, "imported");
if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });

const SUPABASE_PUBLIC_URL = (process.env.SUPABASE_PUBLIC_URL || "https://supabase-eloigfamily.duckdns.org").replace(/\/+$/, "");
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || "";
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || "wardrobe";

const db = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

async function sql(query, params = []) {
  const result = await db.query(query, params);
  return result.rows;
}

async function sqlOne(query, params = []) {
  const rows = await sql(query, params);
  return rows[0] || null;
}

// ─── Supabase Storage ─────────────────────────────────────────────────────────

function supabaseStorageHead() {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  };
}

async function uploadToStorage(filename, buffer, contentType = "image/png") {
  if (!SUPABASE_SERVICE_KEY) return false;
  try {
    const res = await fetch(`${SUPABASE_PUBLIC_URL}/storage/v1/object/${SUPABASE_BUCKET}/${filename}`, {
      method: "POST",
      headers: { ...supabaseStorageHead(), "Content-Type": contentType },
      body: buffer,
    });
    if (!res.ok) {
      console.error(`[wardrobe][storage] upload ${filename} failed: ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[wardrobe][storage] upload ${filename} error: ${err.message}`);
    return false;
  }
}

async function storageRead(filename) {
  if (!SUPABASE_SERVICE_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_PUBLIC_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${filename}`, {
      headers: supabaseStorageHead(),
    });
    if (!res.ok) return null;
    const mime = res.headers.get("content-type") || "image/png";
    return { mime, body: Buffer.from(await res.arrayBuffer()) };
  } catch (err) {
    console.error(`[wardrobe][storage] read ${filename} error: ${err.message}`);
    return null;
  }
}

function getUserId(req) {
  return req.headers["x-user-id"] || null;
}

function requireUser(req) {
  const uid = getUserId(req);
  if (!uid) throw Object.assign(new Error("Unauthorized"), { status: 401 });
  return uid;
}

const GUEST_COOKIE = "wardrobe_uid";

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1) {
      const k = part.slice(0, eq).trim();
      const v = part.slice(eq + 1).trim();
      try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
    }
  }
  return out;
}

async function apiGuestUser(req, res) {
  const headerUid = getUserId(req);
  if (headerUid) {
    const u = await sqlOne("SELECT * FROM users WHERE id = $1", [headerUid]);
    if (u) return json(res, 200, { userId: u.id, username: u.username, displayName: u.display_name });
    return json(res, 200, { userId: headerUid, username: "", displayName: "" });
  }
  const uid = parseCookies(req)[GUEST_COOKIE];
  if (uid) {
    const u = await sqlOne("SELECT * FROM users WHERE id = $1", [uid]);
    if (u) return json(res, 200, { userId: u.id, username: u.username, displayName: u.display_name });
  }
  const rows = await sql(
    "INSERT INTO users (username, password_hash, display_name) VALUES ($1, '', 'Invitado') RETURNING *",
    [`guest_${randomUUID().slice(0, 12)}`]
  );
  res.setHeader(
    "Set-Cookie",
    `${GUEST_COOKIE}=${encodeURIComponent(rows[0].id)}; HttpOnly; Path=/; Max-Age=31536000; SameSite=Lax`
  );
  json(res, 200, { userId: rows[0].id, username: rows[0].username, displayName: rows[0].display_name });
}

function mapItem(g) {
  return {
    id: g.id, name: g.name, part: g.part, color: g.color,
    secondaryColor: g.secondary_color, palette: g.palette || [],
    tags: g.tags || [],
    image: g.image_url, thumbnail: g.thumbnail_url || g.image_url,
    modeledImage: g.modeled_url || null,
    gender: g.gender, style: g.style || [], season: g.season || [],
    occasion: g.occasion || [], material: g.material, pattern: g.pattern,
    fit: g.fit, neckline: g.neckline, length: g.length,
    details: g.details || [], weather: g.weather || [],
    warmthLevel: g.warmth_level, formalityLevel: g.formality_level,
    trendScore: g.trend_score, brand: g.brand, description: g.description,
  };
}

// ─── Background Removal ─────────────────────────────────────────────────────────

const PART_ALLOWED = ["upperbody", "wholebody_up", "lowerbody", "accessories_up", "shoes"];
const FIT_ALLOWED = ["slim", "regular", "loose", "oversized", "petite", "tall"];
const GENDER_ALLOWED = ["male", "female", "unisex"];

function clampScore(value, fallback = 3) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : fallback;
}

function sanitizeMetadata(meta) {
  const m = { ...(meta || {}) };
  if (!Array.isArray(m.palette)) m.palette = [];
  if (!Array.isArray(m.tags)) m.tags = [];
  if (!Array.isArray(m.style)) m.style = [];
  if (!Array.isArray(m.season)) m.season = [];
  if (!Array.isArray(m.occasion)) m.occasion = [];
  if (!Array.isArray(m.details)) m.details = [];
  if (!Array.isArray(m.weather)) m.weather = [];
  m.gender = GENDER_ALLOWED.includes(m.gender) ? m.gender : null;
  m.fit = FIT_ALLOWED.includes(m.fit) ? m.fit : null;
  m.warmth_level = clampScore(m.warmth_level);
  m.formality_level = clampScore(m.formality_level);
  m.trend_score = clampScore(m.trend_score);
  return m;
}

async function removeWhiteBackground(buffer) {
  return removeBackground(buffer);
}

// ─── Gemini Vision ────────────────────────────────────────────────────────────

async function analyzeGarmentWithGemini(imageBase64, mimeType = "image/png", modelName = "gemini-3.6-flash") {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured");

  const prompt = `Analiza esta imagen de prenda y extrae TODA la siguiente metadatos como JSON. Sé lo más preciso posible. Devuelve SOLAMENTE JSON válido, sin markdown. TODOS los campos de texto libre (name, description, tags, brand) DEBEN estar en español de España (tú/vosotros). Para los campos con listas fijas usa EXACTAMENTE los tokens en inglés que se indican a continuación.

{
  "name": "nombre descriptivo en español (ej. 'Camisa azul de algodón Oxford')",
  "part": "upperbody|wholebody_up|lowerbody|accessories_up|shoes",
  "gender": "male|female|unisex",
  "color": "código hex del color dominante (ej. #2c5f8a)",
  "secondary_color": "código hex del color secundario o null",
  "palette": ["hasta 5 códigos hex de los colores detectados"],
  "style": ["array de estilos usando tokens: casual, formal, sporty, elegant, streetwear, bohemian, minimalist, classic, preppy, vintage, luxury, relaxed, trendy, professional, romantic"],
  "season": ["array usando tokens: spring, summer, autumn, winter"],
  "occasion": ["array usando tokens: casual, formal, work, party, sport, beach, evening, everyday, date, travel, outdoor"],
  "material": "material detectado en español (ej. algodón, mezclilla, cuero, seda, lana, poliéster, lino, terciopelo, encaje, piqué, satén, nailon)",
  "pattern": "estampado detectado en español (ej. liso, rayas, cuadros, floral, lunares, geométrico, abstracto, camuflaje, batik, estampado)",
  "fit": "slim|regular|loose|oversized|petite|tall",
  "neckline": "crew_neck|v_neck|polo|henley|turtleneck|boat_neck|square_neck|off_shoulder|collared|zippered|halter|none",
  "length": "crop|regular|long|maxi|mini|ankle|knee|thigh|calf",
  "details": ["array de detalles en español: botones, cremallera, bolsillos, bordado, volantes, cinturón, capucha, cordón, pliegues, encaje, lentejuelas, flecos, parches, logo, remaches, costuras"],
  "weather": ["array usando tokens: hot, warm, mild, cool, cold, rainy, windy"],
  "warmth_level": "escala 1-5 (1=muy ligera como camiseta, 5=muy cálida como abrigo grueso)",
  "formality_level": "escala 1-5 (1=muy informal como pantalón de chandal, 5=muy formal como esmoquin)",
  "trend_score": "escala 1-5 según tendencias actuales",
  "brand": "nombre de la marca detectada o null si no es visible",
  "description": "breve descripción de 1-2 oraciones en español",
  "tags": ["array de etiquetas relevantes en español para búsqueda y coincidencia"]
}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType, data: imageBase64 } }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 2048 }
      }),
      signal: controller.signal,
    }
  );
  clearTimeout(timer);

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini API error: ${response.status} ${err}`);
  }

  const result = await response.json();
  const text = result.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Gemini did not return valid JSON");
  return sanitizeMetadata(JSON.parse(jsonMatch[0]));
}

const GEMINI_FALLBACK = {
  name: "Prenda importada",
  part: "upperbody",
  gender: "unisex",
  color: null,
  secondary_color: null,
  palette: [],
  style: [],
  season: [],
  occasion: [],
  material: null,
  pattern: null,
  fit: null,
  neckline: null,
  length: null,
  details: [],
  weather: [],
  warmth_level: 3,
  formality_level: 3,
  trend_score: 3,
  brand: null,
  description: "",
  tags: [],
};

async function analyzeGarmentSafe(imageBase64, mimeType) {
  const models = ["gemini-3.6-flash", "gemini-3-flash", "gemini-2.5-flash"];
  let lastErr;
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const meta = await analyzeGarmentWithGemini(imageBase64, mimeType, model);
        if (meta && typeof meta === "object" && Object.keys(meta).length) return meta;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
  }
  console.error(`[import][gemini] all models failed (${models.join(", ")}): ${lastErr?.message}`);
  return { ...GEMINI_FALLBACK };
}

// ─── Outfit Rules Engine ─────────────────────────────────────────────────────

function hexToHSL(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return { h: h * 360, s: s * 100, l: l * 100 };
}

function colorDistance(hex1, hex2) {
  if (!hex1 || !hex2) return 999;
  const h1 = hexToHSL(hex1), h2 = hexToHSL(hex2);
  return Math.sqrt((h1.h - h2.h) ** 2 + (h1.s - h2.s) ** 2 + (h1.l - h2.l) ** 2);
}

function isNeutral(hex) {
  if (!hex) return false;
  const hsl = hexToHSL(hex);
  return hsl.s < 15 || (hsl.l < 15 || hsl.l > 85);
}

function scoreColorCombo(a, b) {
  if (!a?.color || !b?.color) return 5;
  if (isNeutral(a.color) || isNeutral(b.color)) return 10;
  const dist = colorDistance(a.color, b.color);
  if (dist < 30) return 6;
  if (dist < 60) return 9;
  if (dist < 120) return 7;
  return 4;
}

function scoreStyleMatch(a, b) {
  const sa = new Set(a.style || []);
  const sb = new Set(b.style || []);
  return [...sa].filter(x => sb.has(x)).length * 3;
}

function scoreSeasonMatch(a, b) {
  const sa = new Set(a.season || []);
  const sb = new Set(b.season || []);
  if (!sa.size || !sb.size) return 3;
  return [...sa].filter(x => sb.has(x)).length * 2;
}

function scoreOccasionMatch(a, b) {
  const oa = new Set(a.occasion || []);
  const ob = new Set(b.occasion || []);
  if (!oa.size || !ob.size) return 3;
  return [...oa].filter(x => ob.has(x)).length * 2;
}

function scoreFormality(a, b) {
  const fa = a.formality_level || 3;
  const fb = b.formality_level || 3;
  const diff = Math.abs(fa - fb);
  return diff === 0 ? 8 : diff === 1 ? 5 : diff === 2 ? 2 : -3;
}

function scoreWarmth(a, b, targetSeason) {
  const targets = { hot: 1, warm: 2, mild: 3, cool: 4, cold: 5 };
  const target = targets[targetSeason] || 3;
  const total = ((a.warmth_level || 3) + (b.warmth_level || 3)) / 2;
  const diff = Math.abs(total - target);
  return diff < 1 ? 5 : diff < 2 ? 3 : 1;
}

function generateOutfitSuggestions(items, context = {}) {
  const { season = "mild" } = context;

  const tops = items.filter(i => i.part === "upperbody" || i.part === "wholebody_up");
  const bottoms = items.filter(i => i.part === "lowerbody");
  const shoes = items.filter(i => i.part === "shoes");
  const accs = items.filter(i => i.part === "accessories_up");

  const suggestions = [];

  for (const top of tops) {
    for (const bottom of bottoms) {
      let total = 0;
      const reasons = [];

      const colorScore = scoreColorCombo(top, bottom);
      total += colorScore;
      if (colorScore >= 9) reasons.push("gran combinación de color");

      const styleScore = scoreStyleMatch(top, bottom);
      total += styleScore;
      if (styleScore >= 6) reasons.push("estilos que combinan");

      total += scoreSeasonMatch(top, bottom);
      total += scoreOccasionMatch(top, bottom);

      const formScore = scoreFormality(top, bottom);
      total += formScore;
      if (formScore >= 6) reasons.push("etiqueta similar");

      const bestShoes = shoes.reduce((best, shoe) => {
        let s = scoreColorCombo(top, shoe) + scoreColorCombo(bottom, shoe);
        s += scoreStyleMatch(top, shoe) + scoreStyleMatch(bottom, shoe);
        s += scoreFormality(top, shoe);
        return s > best.score ? { item: shoe, score: s } : best;
      }, { item: null, score: -999 });

      const bestAcc = accs.reduce((best, acc) => {
        let s = scoreColorCombo(top, acc) + scoreColorCombo(bottom, acc);
        s += scoreStyleMatch(top, acc);
        return s > best.score ? { item: acc, score: s } : best;
      }, { item: null, score: -999 });

      if (bestShoes.item) { total += bestShoes.score * 0.3; }
      if (bestAcc.item) { total += bestAcc.score * 0.2; }

      total += scoreWarmth(top, bottom, season);
      if (total < 15) continue;

      const garmentIds = [top.id, bottom.id];
      if (bestShoes.item) garmentIds.push(bestShoes.item.id);
      if (bestAcc.item) garmentIds.push(bestAcc.item.id);

      const avgFormality = ((top.formality_level || 3) + (bottom.formality_level || 3)) / 2;
      let occasionLabel = "casual";
      if (avgFormality >= 4) occasionLabel = "elegante";
      else if (avgFormality >= 3) occasionLabel = "semi-formal";
      else if (avgFormality <= 1.5) occasionLabel = "sport";

      suggestions.push({
        name: `${top.name} + ${bottom.name}`,
        occasion: occasionLabel,
        garmentIds,
        score: Math.round(total * 100) / 100,
        reasons,
        season: [...new Set([...(top.season || []), ...(bottom.season || [])])],
        weather: [...new Set([...(top.weather || []), ...(bottom.weather || [])])],
      });
    }
  }

  suggestions.sort((a, b) => b.score - a.score);
  const unique = [];
  const seen = new Set();
  for (const s of suggestions) {
    const key = [...s.garmentIds].sort().join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(s);
    if (unique.length >= 10) break;
  }
  return unique;
}

// ─── Outfit Feedback (teaching signal) ────────────────────────────────────────

async function apiOutfitFeedback(req, res) {
  const uid = requireUser(req);
  const input = await parseBody(req);
  const { outfitId, liked, occasion, season, weather } = input;

  if (!outfitId) return json(res, 400, { error: "outfitId required" });
  const outfit = await sqlOne("SELECT id FROM outfits WHERE id = $1 AND user_id = $2", [outfitId, uid]);
  if (!outfit) return json(res, 404, { error: "Outfit not found" });

  await sql("DELETE FROM outfit_feedback WHERE outfit_id = $1", [outfitId]);
  const insert = await sql(
    `INSERT INTO outfit_feedback (outfit_id, liked, weather, occasion, season)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id`,
    [
      outfitId,
      liked === true || liked === false ? liked : null,
      weather || null,
      occasion || null,
      season || null,
    ]
  );
  json(res, 200, { id: insert[0]?.id, outfitId, liked });
}

// ─── API Handlers ─────────────────────────────────────────────────────────────

async function apiStatus(req, res) {
  json(res, 200, {
    hasDatabase: Boolean(DATABASE_URL),
    hasGemini: Boolean(GEMINI_API_KEY),
    ready: Boolean(DATABASE_URL),
  });
}

async function apiGetGarments(req, res) {
  const uid = requireUser(req);
  const rows = await sql("SELECT * FROM items WHERE active = true AND user_id = $1 ORDER BY created_at DESC", [uid]);
  json(res, 200, rows.map(mapItem));
}

async function apiGetGarment(req, res, id) {
  const uid = requireUser(req);
  const g = await sqlOne("SELECT * FROM items WHERE id = $1 AND user_id = $2", [id, uid]);
  if (!g) return json(res, 404, { error: "Not found" });
  json(res, 200, mapItem(g));
}

async function apiUpdateGarment(req, res, id) {
  const uid = requireUser(req);
  const existing = await sqlOne("SELECT * FROM items WHERE id = $1 AND user_id = $2", [id, uid]);
  if (!existing) return json(res, 404, { error: "Not found" });
  const input = await parseBody(req);
  await sql(`UPDATE items SET
    name = $1, part = $2, color = $3, secondary_color = $4, palette = $5, tags = $6,
    gender = $7, style = $8, season = $9, occasion = $10, material = $11,
    pattern = $12, fit = $13, neckline = $14, length = $15, details = $16,
    weather = $17, warmth_level = $18, formality_level = $19, trend_score = $20,
    brand = $21, description = $22 WHERE id = $23 AND user_id = $24`, [
    (input.name || "").trim().slice(0, 120) || "New piece",
    input.part || "upperbody",
    input.color || null,
    input.secondaryColor || null,
    JSON.stringify(Array.isArray(input.palette) ? input.palette : []),
    input.tags || [],
    input.gender || null,
    input.style || [],
    input.season || [],
    input.occasion || [],
    input.material || null,
    input.pattern || null,
    input.fit || null,
    input.neckline || null,
    input.length || null,
    input.details || [],
    input.weather || [],
    input.warmthLevel || null,
    input.formalityLevel || null,
    input.trendScore || null,
    input.brand || null,
    input.description || null,
    id, uid,
  ]);
  const g = await sqlOne("SELECT * FROM items WHERE id = $1", [id]);
  json(res, 200, mapItem(g));
}

async function apiDeleteGarment(req, res, id) {
  const uid = requireUser(req);
  await sql("UPDATE items SET active = false WHERE id = $1 AND user_id = $2", [id, uid]);
  json(res, 200, { deleted: true, id });
}

async function apiImportGarment(req, res) {
  const uid = requireUser(req);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  const { imageBase64, mimeType = "image/png" } = body;

  if (!imageBase64) return json(res, 400, { error: "imageBase64 required" });

  const metadata = await analyzeGarmentSafe(imageBase64, mimeType);
  const part = PART_ALLOWED.includes(metadata.part) ? metadata.part : "upperbody";

  const slug = `g-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const filename = `${slug}.png`;
  const imagePath = `${UPLOAD_DIR}/${filename}`;

  const buffer = Buffer.from(imageBase64, "base64");
  const cleanBuffer = await removeWhiteBackground(buffer);
  writeFileSync(imagePath, cleanBuffer);
  await uploadToStorage(filename, cleanBuffer);

  const rows = await sql(`INSERT INTO items
    (slug, name, part, color, secondary_color, palette, tags, image_url, thumbnail_url,
     gender, style, season, occasion, material, pattern, fit, neckline, length,
     details, weather, warmth_level, formality_level, trend_score, brand, description, user_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
    RETURNING *`, [
    slug,
    metadata.name || "Imported piece",
    part,
    metadata.color || null,
    metadata.secondary_color || null,
    JSON.stringify(metadata.palette || []),
    metadata.tags || [],
    `/api/library/${filename}`,
    `/api/library/${filename}`,
    metadata.gender || null,
    metadata.style || [],
    metadata.season || [],
    metadata.occasion || [],
    metadata.material || null,
    metadata.pattern || null,
    metadata.fit || null,
    metadata.neckline || null,
    metadata.length || null,
    metadata.details || [],
    metadata.weather || [],
    metadata.warmth_level || null,
    metadata.formality_level || null,
    metadata.trend_score || null,
    metadata.brand || null,
    metadata.description || null,
    uid,
  ]);

  const g = rows[0];
  json(res, 201, { ...mapItem(g), metadata });
}

async function apiGetOutfits(req, res) {
  const uid = requireUser(req);
  const rows = await sql("SELECT * FROM outfits WHERE user_id = $1 ORDER BY created_at DESC", [uid]);
  const result = await Promise.all(rows.map(async o => {
    const items = await sql(
      "SELECT oi.item_id FROM outfit_items oi JOIN items i ON i.id = oi.item_id WHERE oi.outfit_id = $1 AND i.active = true AND i.user_id = $2 ORDER BY oi.position",
      [o.id, uid]
    );
    if (!items.length) return null;
    return {
      id: o.id, name: o.name, occasion: o.occasion, season: o.season,
      isFavorite: o.is_favorite, uses: o.uses,
      garmentIds: items.map(i => i.item_id),
      weather: o.weather || [], formalityLevel: o.formality_level,
      style: o.style || [], score: o.score,
      createdAt: o.created_at, updatedAt: o.updated_at,
    };
  }));
  json(res, 200, result.filter(Boolean));
}

async function apiCreateOutfit(req, res) {
  const uid = requireUser(req);
  const input = await parseBody(req);
  const rows = await sql(
    `INSERT INTO outfits (name, occasion, season, weather, formality_level, style, score, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [input.name || "Nuevo outfit", input.occasion || null, input.season || null,
     input.weather || [], input.formalityLevel || null, input.style || [], input.score || null, uid]
  );
  const outfit = rows[0];
  if (Array.isArray(input.garmentIds) && input.garmentIds.length) {
    const groups = input.garmentIds.map((_, i) => `($${i * 3 + 1},$${i * 3 + 2},$${i * 3 + 3})`).join(",");
    await sql(
      `INSERT INTO outfit_items (outfit_id, item_id, position) VALUES ${groups}`,
      input.garmentIds.flatMap((gid, i) => [outfit.id, gid, i])
    );
  }
  json(res, 201, {
    id: outfit.id, name: outfit.name, occasion: outfit.occasion, season: outfit.season,
    garmentIds: input.garmentIds || [], weather: outfit.weather || [],
    formalityLevel: outfit.formality_level, style: outfit.style || [],
    createdAt: outfit.created_at, updatedAt: outfit.updated_at,
  });
}

async function apiUpdateOutfit(req, res, id) {
  const uid = requireUser(req);
  const existing = await sqlOne("SELECT * FROM outfits WHERE id = $1 AND user_id = $2", [id, uid]);
  if (!existing) return json(res, 404, { error: "Not found" });
  const input = await parseBody(req);
  await sql(
    `UPDATE outfits SET name=$1, occasion=$2, season=$3, weather=$4, formality_level=$5, style=$6, score=$7 WHERE id=$8 AND user_id=$9`,
    [input.name, input.occasion || null, input.season || null,
     input.weather || [], input.formalityLevel || null, input.style || [], input.score || null, id, uid]
  );
  if ("garmentIds" in input) {
    await sql("DELETE FROM outfit_items WHERE outfit_id = $1", [id]);
    if (Array.isArray(input.garmentIds) && input.garmentIds.length) {
      const groups = input.garmentIds.map((_, i) => `($${i * 3 + 1},$${i * 3 + 2},$${i * 3 + 3})`).join(",");
      await sql(
        `INSERT INTO outfit_items (outfit_id, item_id, position) VALUES ${groups}`,
        input.garmentIds.flatMap((gid, i) => [id, gid, i])
      );
    }
  }
  const o = await sqlOne("SELECT * FROM outfits WHERE id = $1", [id]);
  const items = await sql("SELECT item_id FROM outfit_items WHERE outfit_id = $1", [id]);
  json(res, 200, {
    id: o.id, name: o.name, occasion: o.occasion, season: o.season,
    garmentIds: items.map(i => i.item_id), weather: o.weather || [],
    formalityLevel: o.formality_level, style: o.style || [],
    createdAt: o.created_at, updatedAt: o.updated_at,
  });
}

async function apiDeleteOutfit(req, res, id) {
  const uid = requireUser(req);
  const existing = await sqlOne("SELECT id FROM outfits WHERE id = $1 AND user_id = $2", [id, uid]);
  if (!existing) return json(res, 404, { error: "Not found" });
  await sql("DELETE FROM outfit_items WHERE outfit_id = $1", [id]);
  await sql("DELETE FROM outfits WHERE id = $1 AND user_id = $2", [id, uid]);
  json(res, 200, { deleted: true, id });
}

async function apiSuggestOutfits(req, res) {
  const uid = requireUser(req);
  const url = new URL(req.url, "http://localhost");
  const params = new URLSearchParams(url.search);
  const mode = params.get("mode") || "smart";
  const season = params.get("season") || "mild";
  const color = params.get("color") || "";
  const mood = (params.get("mood") || "").toLowerCase();
  const condition = (params.get("condition") || "").toLowerCase();
  const temp = parseFloat(params.get("temp") || "NaN");

  const rows = await sql("SELECT * FROM items WHERE active = true AND user_id = $1", [uid]);
  if (!rows.length) return json(res, 200, { outfits: [], message: "Add garments first" });

  const tops = rows.filter(i => i.part === "upperbody" || i.part === "wholebody_up");
  const bottoms = rows.filter(i => i.part === "lowerbody");
  const shoes = rows.filter(i => i.part === "shoes");
  const accs = rows.filter(i => i.part === "accessories_up");
  if (!tops.length || !bottoms.length) return json(res, 200, { outfits: [], message: "Need at least one top and one bottom" });

  const buildOutfit = (top, bottom) => {
    const bestShoes = shoes.reduce((best, shoe) => {
      let s = scoreColorCombo(top, shoe) + scoreColorCombo(bottom, shoe);
      s += scoreStyleMatch(top, shoe) + scoreStyleMatch(bottom, shoe);
      s += scoreFormality(top, shoe);
      return s > best.score ? { item: shoe, score: s } : best;
    }, { item: null, score: -999 });
    const bestAcc = accs.reduce((best, acc) => {
      let s = scoreColorCombo(top, acc) + scoreColorCombo(bottom, acc);
      s += scoreStyleMatch(top, acc);
      return s > best.score ? { item: acc, score: s } : best;
    }, { item: null, score: -999 });

    const garmentIds = [top.id, bottom.id];
    if (bestShoes.item) garmentIds.push(bestShoes.item.id);
    if (bestAcc.item) garmentIds.push(bestAcc.item.id);

    const avgFormality = ((top.formality_level || 3) + (bottom.formality_level || 3)) / 2;
    let occasionLabel = "casual";
    if (avgFormality >= 4) occasionLabel = "elegante";
    else if (avgFormality >= 3) occasionLabel = "semi-formal";
    else if (avgFormality <= 1.5) occasionLabel = "deportivo";

    let score = scoreColorCombo(top, bottom) + scoreStyleMatch(top, bottom)
      + scoreSeasonMatch(top, bottom) + scoreOccasionMatch(top, bottom)
      + scoreFormality(top, bottom) + scoreWarmth(top, bottom, season)
      + (bestShoes.item ? bestShoes.score * 0.3 : 0) + (bestAcc.item ? bestAcc.score * 0.2 : 0);

    const reasons = [];
    if (scoreColorCombo(top, bottom) >= 9) reasons.push("gran combinación de color");
    if (scoreStyleMatch(top, bottom) >= 6) reasons.push("estilos que combinan");
    if (scoreFormality(top, bottom) >= 6) reasons.push("etiqueta similar");

    return { top, bottom, bestShoes, bestAcc, garmentIds, occasion: occasionLabel, score: Math.round(score * 100) / 100, reasons };
  };

  let ranked = [];

  if (mode === "random") {
    const pool = [];
    const pairCount = Math.min(20, tops.length * bottoms.length || 1);
    for (let n = 0; n < pairCount; n++) {
      const t = tops[Math.floor(Math.random() * tops.length)];
      const b = bottoms[Math.floor(Math.random() * bottoms.length)];
      pool.push(buildOutfit(t, b));
    }
    ranked = pool.sort(() => Math.random() - 0.5);
  } else if (mode === "color" && color) {
    ranked = tops.flatMap(top => bottoms.map(bottom => {
      const o = buildOutfit(top, bottom);
      const closest = [top, bottom].map(g => g.color ? 100 / (1 + (colorDistance(g.color, color) / 60)) : 0);
      o.score = o.score * 0.6 + Math.max(...closest) * 4;
      if (Math.max(...closest) > 30) o.reasons.unshift(`encaja con la paleta ${color}`);
      return o;
    })).sort((a, b) => b.score - a.score);
  } else if (mode === "mood") {
    const targetFormality = mood === "formal" || mood === "elegant" ? 4 : mood === "smart" ? 3 : mood === "sport" ? 1 : 2;
    ranked = tops.flatMap(top => bottoms.map(bottom => {
      const o = buildOutfit(top, bottom);
      const too = Math.abs((top.formality_level || 3) - targetFormality);
      const bho = Math.abs((bottom.formality_level || 3) - targetFormality);
      o.score = o.score * 0.7 - (too + bho) * 6;
      return o;
    })).sort((a, b) => b.score - a.score);
  } else if (mode === "weather" && condition) {
    const condToWeather = { clear: ["warm"], sunny: ["hot", "warm"], cloudy: ["mild"], rain: ["cool", "rainy"], snow: ["cold"], thunderground: ["cool"] };
    const CONDITION_LABEL = { clear: "despejado", sunny: "despejado", cloudy: "nublado", rain: "lluvia", snow: "nieve", thunderground: "tormenta" };
    const wantedWeather = condToWeather[condition] || [];
    const tempIndex = isNaN(temp) ? null : (temp >= 28 ? "hot" : temp >= 22 ? "warm" : temp >= 15 ? "mild" : temp >= 7 ? "cool" : "cold");
    ranked = tops.flatMap(top => bottoms.map(bottom => {
      const o = buildOutfit(top, bottom);
      let bonus = 0;
      for (const g of [top, bottom]) {
        const gw = (g.weather || []).map(x => x.toLowerCase());
        if (wantedWeather.some(w => gw.includes(w))) bonus += 3;
        if (tempIndex && (g.warmth_level || 3) >= (tempIndex === "hot" ? 3 : tempIndex === "cold" ? 4 : 3)) bonus += 2;
      }
      o.score += bonus;
      if (wantedWeather.some(w => (top.weather || []).map(x => x.toLowerCase()).includes(w) || (bottom.weather || []).map(x => x.toLowerCase()).includes(w))) {
        o.reasons.push(`ideal para tiempo ${CONDITION_LABEL[condition] || condition}`);
      }
      return o;
    })).sort((a, b) => b.score - a.score);
  } else {
    ranked = tops.flatMap(top => bottoms.map(bottom => buildOutfit(top, bottom)))
      .sort((a, b) => b.score - a.score);
  }

  const suggestions = [];
  const seen = new Set();
  for (const o of ranked) {
    const key = [...o.garmentIds].sort().join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push({
      name: `${o.top.name} + ${o.bottom.name}`,
      occasion: o.occasion,
      garmentIds: o.garmentIds,
      score: o.score,
      reasons: o.reasons,
      mode,
      season: [...new Set([...(o.top.season || []), ...(o.bottom.season || [])])],
      weather: [...new Set([...(o.top.weather || []), ...(o.bottom.weather || [])])],
    });
    if (suggestions.length >= 10) break;
  }

  json(res, 200, { outfits: suggestions, context: { mode, season, color, mood, condition, temp } });
}

async function apiLogin(req, res) {
  const input = await parseBody(req);
  const { username, password } = input;
  if (!username || !password) return json(res, 400, { error: "username and password required" });
  const user = await sqlOne("SELECT * FROM users WHERE username = $1", [username]);
  if (!user) return json(res, 401, { error: "Invalid credentials" });
  if (user.password_hash !== password) return json(res, 401, { error: "Invalid credentials" });
  json(res, 200, { userId: user.id, username: user.username, displayName: user.display_name });
}

async function apiRegister(req, res) {
  const input = await parseBody(req);
  const { username, password, displayName } = input;
  if (!username || !password) return json(res, 400, { error: "username and password required" });
  if (username.length < 3) return json(res, 400, { error: "Username must be at least 3 characters" });
  if (password.length < 4) return json(res, 400, { error: "Password must be at least 4 characters" });
  try {
    const rows = await sql(
      "INSERT INTO users (username, password_hash, display_name) VALUES ($1, $2, $3) RETURNING *",
      [username, password, displayName || username]
    );
    const user = rows[0];
    json(res, 201, { userId: user.id, username: user.username, displayName: user.display_name });
  } catch (err) {
    if (err.code === "23505") return json(res, 409, { error: "Username already taken" });
    json(res, 500, { error: err.message });
  }
}

async function apiLibrary(req, res, filename) {
  const storageFile = await storageRead(filename);
  if (storageFile) {
    res.writeHead(200, { "Content-Type": storageFile.mime, "Cache-Control": "public, max-age=86400" });
    return res.end(storageFile.body);
  }
  const filePath = resolve(UPLOAD_DIR, filename);
  if (!existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Not found" }));
  }
  const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp" }[extname(filename).toLowerCase()] || "image/png";
  res.writeHead(200, { "Content-Type": mime, "Cache-Control": "public, max-age=86400" });
  res.end(readFileSync(filePath));
}

// ─── Router ───────────────────────────────────────────────────────────────────

async function handleApi(req, res) {
  const url = new URL(req.url, "http://localhost");
  const { pathname } = url;

  try {
    if (req.method === "GET" && pathname === "/api/status") { await apiStatus(req, res); return true; }
    if (req.method === "POST" && pathname === "/api/auth/login") { await apiLogin(req, res); return true; }
    if (req.method === "POST" && pathname === "/api/auth/register") { await apiRegister(req, res); return true; }
    if (req.method === "GET" && pathname === "/api/auth/guest") { await apiGuestUser(req, res); return true; }
    if (req.method === "GET" && pathname === "/api/garments") { await apiGetGarments(req, res); return true; }
    if (req.method === "POST" && pathname === "/api/garments/import") { await apiImportGarment(req, res); return true; }
    if (req.method === "GET" && pathname === "/api/outfits") { await apiGetOutfits(req, res); return true; }
    if (req.method === "GET" && pathname === "/api/outfits/suggest") { await apiSuggestOutfits(req, res); return true; }
    if (req.method === "POST" && pathname === "/api/outfits") { await apiCreateOutfit(req, res); return true; }
    if (req.method === "POST" && pathname === "/api/outfits/feedback") { await apiOutfitFeedback(req, res); return true; }

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

    const libMatch = pathname.match(/^\/api\/library\/(.+)$/);
    if (req.method === "GET" && libMatch) { await apiLibrary(req, res, libMatch[1]); return true; }

    return false;
  } catch (err) {
    const status = typeof err?.status === "number" ? err.status : 500;
    console.error("[wardrobe]", err.message);
    if (status >= 500) console.error(err.stack);
    json(res, status, { error: err.message || "Internal server error" });
    return true;
  }
}

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
  const cache = filePath.endsWith("index.html") ? "no-cache" : "public, max-age=86400";
  res.writeHead(200, { "Content-Type": mime, "Cache-Control": cache });
  res.end(readFileSync(filePath));
}

const server = createHttpServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    if (await handleApi(req, res)) return;
  }
  serveStatic(req, res);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[wardrobe] http://localhost:${PORT}`);
  console.log(`[wardrobe] Database: ${DATABASE_URL ? "connected" : "MISSING"}`);
  console.log(`[wardrobe] Gemini: ${GEMINI_API_KEY ? "configured" : "MISSING"}`);
});

process.on("SIGTERM", () => server.close());
process.on("SIGINT", () => server.close());
