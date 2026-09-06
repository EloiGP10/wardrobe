import { createServer as createHttpServer } from "node:http";
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const DATABASE_URL = process.env.DATABASE_URL || "";
const PORT = parseInt(process.env.PORT || "3000", 10);
const DIST_DIR = resolve(process.env.DIST_DIR || "dist");
const DATA_DIR = resolve(process.cwd(), "data");
const UPLOAD_DIR = resolve(DATA_DIR, "imported");
if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });

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

function getUserId(req) {
  return req.headers["x-user-id"] || null;
}

function requireUser(req) {
  const uid = getUserId(req);
  if (!uid) throw Object.assign(new Error("Unauthorized"), { status: 401 });
  return uid;
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

// ─── Gemini Vision ────────────────────────────────────────────────────────────

async function analyzeGarmentWithGemini(imageBase64, mimeType = "image/png") {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured");

  const prompt = `Analyze this clothing item image and extract ALL of the following metadata as JSON. Be as precise as possible. Return ONLY valid JSON, no markdown.

{
  "name": "descriptive name (e.g. 'Blue Cotton Oxford Shirt')",
  "part": "upperbody|wholebody_up|lowerbody|accessories_up|shoes",
  "gender": "male|female|unisex",
  "color": "hex code of dominant color (e.g. #2c5f8a)",
  "secondary_color": "hex code of secondary color or null",
  "palette": ["up to 5 hex codes of colors found"],
  "style": ["array of styles from: casual, formal, sporty, elegant, streetwear, bohemian, minimalist, classic, preppy, vintage, luxury, relaxed, trendy, professional, romantic"],
  "season": ["array from: spring, summer, autumn, winter"],
  "occasion": ["array from: casual, formal, work, party, sport, beach, evening, everyday, date, travel, outdoor"],
  "material": "detected material (e.g. cotton, denim, leather, silk, wool, polyester, linen, velvet, chiffon, jersey, cashmere, suede, nylon)",
  "pattern": "detected pattern (e.g. solid, striped, plaid, floral, polka_dot, geometric, abstract, camo, tie_dye, paisley, houndstooth, checkered)",
  "fit": "slim|regular|loose|oversized|petite|tall",
  "neckline": "crew_neck|v_neck|polo|henley|turtleneck|boat_neck|square_neck|off_shoulder|collared|zippered|halter|none",
  "length": "crop|regular|long|maxi|mini|ankle|knee|thigh|calf",
  "details": ["array of notable features: buttons, zipper, pockets, embroidery, ruffles, belt, hood, drawstring, pleats, lace, sequins, fringes, patches, logo, rivets, stitching"],
  "weather": ["array from: hot, warm, mild, cool, cold, rainy, windy"],
  "warmth_level": "1-5 scale (1=very light like tank top, 5=very warm like heavy coat)",
  "formality_level": "1-5 scale (1=very casual like gym shorts, 5=very formal like tuxedo)",
  "trend_score": "1-5 scale based on current fashion trends",
  "brand": "detected brand name or null if not visible",
  "description": "brief 1-2 sentence description of the garment",
  "tags": ["array of relevant tags for searching and matching"]
}`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType, data: imageBase64 } }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 2048 }
      })
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini API error: ${response.status} ${err}`);
  }

  const result = await response.json();
  const text = result.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Gemini did not return valid JSON");
  return JSON.parse(jsonMatch[0]);
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
      if (colorScore >= 9) reasons.push("great color match");

      const styleScore = scoreStyleMatch(top, bottom);
      total += styleScore;
      if (styleScore >= 6) reasons.push("matching styles");

      total += scoreSeasonMatch(top, bottom);
      total += scoreOccasionMatch(top, bottom);

      const formScore = scoreFormality(top, bottom);
      total += formScore;
      if (formScore >= 6) reasons.push("similar formality");

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
      if (avgFormality >= 4) occasionLabel = "formal";
      else if (avgFormality >= 3) occasionLabel = "smart casual";
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

  const metadata = await analyzeGarmentWithGemini(imageBase64, mimeType);

  const slug = `g-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const filename = `${slug}.png`;
  const imagePath = `${UPLOAD_DIR}/${filename}`;

  const buffer = Buffer.from(imageBase64, "base64");
  writeFileSync(imagePath, buffer);

  const rows = await sql(`INSERT INTO items
    (slug, name, part, color, secondary_color, palette, tags, image_url, thumbnail_url,
     gender, style, season, occasion, material, pattern, fit, neckline, length,
     details, weather, warmth_level, formality_level, trend_score, brand, description, user_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
    RETURNING *`, [
    slug,
    metadata.name || "Imported piece",
    metadata.part || "upperbody",
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
      "SELECT item_id FROM outfit_items WHERE outfit_id = $1 ORDER BY position",
      [o.id]
    );
    return {
      id: o.id, name: o.name, occasion: o.occasion, season: o.season,
      isFavorite: o.is_favorite, uses: o.uses,
      garmentIds: items.map(i => i.item_id),
      weather: o.weather || [], formalityLevel: o.formality_level,
      style: o.style || [], score: o.score,
      createdAt: o.created_at, updatedAt: o.updated_at,
    };
  }));
  json(res, 200, result);
}

async function apiCreateOutfit(req, res) {
  const uid = requireUser(req);
  const input = await parseBody(req);
  const rows = await sql(
    `INSERT INTO outfits (name, occasion, season, weather, formality_level, style, score, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [input.name || "New outfit", input.occasion || null, input.season || null,
     input.weather || [], input.formalityLevel || null, input.style || [], input.score || null, uid]
  );
  const outfit = rows[0];
  if (Array.isArray(input.garmentIds) && input.garmentIds.length) {
    await sql(
      `INSERT INTO outfit_items (outfit_id, item_id, position, user_id) VALUES ${input.garmentIds.map((_, i) => `($1,$${i * 2 + 2},$${i * 2 + 3},$${input.garmentIds.length + 4})`).join(",")}`,
      input.garmentIds.flatMap(gid => [outfit.id, gid, uid])
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
    await sql("DELETE FROM outfit_items WHERE outfit_id = $1 AND user_id = $2", [id, uid]);
    if (Array.isArray(input.garmentIds) && input.garmentIds.length) {
      await sql(
        `INSERT INTO outfit_items (outfit_id, item_id, position, user_id) VALUES ${input.garmentIds.map((_, i) => `($1,$${i * 2 + 2},$${i * 2 + 3},$${input.garmentIds.length + 4})`).join(",")}`,
        input.garmentIds.flatMap(gid => [id, gid, uid])
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
  await sql("DELETE FROM outfit_items WHERE outfit_id = $1 AND user_id = $2", [id, uid]);
  await sql("DELETE FROM outfits WHERE id = $1 AND user_id = $2", [id, uid]);
  json(res, 200, { deleted: true, id });
}

async function apiSuggestOutfits(req, res) {
  const uid = getUserId(req);
  const url = new URL(req.url, "http://localhost");
  const season = url.searchParams.get("season") || "mild";
  const userFilter = uid ? "AND user_id = $1" : "";
  const params = uid ? [uid] : [];
  const rows = await sql(`SELECT * FROM items WHERE active = true ${userFilter}`, params);
  if (!rows.length) return json(res, 200, { outfits: uid ? [] : [], message: uid ? "Add garments first" : "Login to see suggestions" });
  const suggestions = generateOutfitSuggestions(rows, { season });
  json(res, 200, { outfits: suggestions });
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
  const filePath = resolve(UPLOAD_DIR, filename);
  if (!existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Not found" }));
  }
  const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp" }[extname(filename).toLowerCase()] || "image/png";
  res.writeHead(200, { "Content-Type": mime, "Cache-Control": "public, max-age=31536000, immutable" });
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
    if (req.method === "GET" && pathname === "/api/garments") { await apiGetGarments(req, res); return true; }
    if (req.method === "POST" && pathname === "/api/garments/import") { await apiImportGarment(req, res); return true; }
    if (req.method === "GET" && pathname === "/api/outfits") { await apiGetOutfits(req, res); return true; }
    if (req.method === "GET" && pathname === "/api/outfits/suggest") { await apiSuggestOutfits(req, res); return true; }
    if (req.method === "POST" && pathname === "/api/outfits") { await apiCreateOutfit(req, res); return true; }

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
    console.error("[wardrobe]", err.message);
    json(res, 500, { error: err.message || "Internal server error" });
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
  res.writeHead(200, { "Content-Type": mime, "Cache-Control": "public, max-age=86400" });
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
