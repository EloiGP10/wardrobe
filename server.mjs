import { createServer as createHttpServer } from "node:http";
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY;
const PORT = parseInt(process.env.PORT || "3000", 10);
const DIST_DIR = resolve(process.env.DIST_DIR || "dist");
const DATA_DIR = resolve(process.cwd(), "data");
const UPLOAD_DIR = resolve(DATA_DIR, "imported");
if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

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
  "warmth_level": 1-5 scale (1=very light like tank top, 5=very warm like heavy coat),
  "formality_level": 1-5 scale (1=very casual like gym shorts, 5=very formal like tuxedo),
  "trend_score": 1-5 scale based on current fashion trends,
  "brand": "detected brand name or null if not visible",
  "description": "brief 1-2 sentence description of the garment",
  "tags": ["array of relevant tags for searching and matching"]
}`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
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

const COLOR_HARMONY = {
  complementary: 0.8,
  analogous: 0.9,
  triadic: 0.7,
  neutral_safe: 1.0,
};

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
  const dist = colorDistance(a.color, b.color);
  if (isNeutral(a.color) || isNeutral(b.color)) return 10;
  if (dist < 30) return 6;
  if (dist < 60) return 9;
  if (dist < 120) return 7;
  return 4;
}

function scoreStyleMatch(a, b) {
  const sa = new Set(a.style || []);
  const sb = new Set(b.style || []);
  const overlap = [...sa].filter(x => sb.has(x)).length;
  return overlap * 3;
}

function scoreSeasonMatch(a, b) {
  const sa = new Set(a.season || []);
  const sb = new Set(b.season || []);
  if (sa.size === 0 || sb.size === 0) return 3;
  const overlap = [...sa].filter(x => sb.has(x)).length;
  return overlap * 2;
}

function scoreOccasionMatch(a, b) {
  const oa = new Set(a.occasion || []);
  const ob = new Set(b.occasion || []);
  if (oa.size === 0 || ob.size === 0) return 3;
  const overlap = [...oa].filter(x => ob.has(x)).length;
  return overlap * 2;
}

function scoreFormality(a, b) {
  const fa = a.formality_level || 3;
  const fb = b.formality_level || 3;
  const diff = Math.abs(fa - fb);
  return diff === 0 ? 8 : diff === 1 ? 5 : diff === 2 ? 2 : -3;
}

function scoreWarmth(a, b, targetSeason) {
  const wa = a.warmth_level || 3;
  const wb = b.warmth_level || 3;
  const targets = { hot: 1, warm: 2, mild: 3, cool: 4, cold: 5 };
  const target = targets[targetSeason] || 3;
  const total = (wa + wb) / 2;
  const diff = Math.abs(total - target);
  return diff < 1 ? 5 : diff < 2 ? 3 : 1;
}

function generateOutfitSuggestions(items, context = {}) {
  const { season = "mild", occasion = "casual", targetWarmth = 3 } = context;

  const tops = items.filter(i => i.part === "upperbody" || i.part === "wholebody_up");
  const bottoms = items.filter(i => i.part === "lowerbody");
  const shoes = items.filter(i => i.part === "shoes");
  const accs = items.filter(i => i.part === "accessories_up");

  const suggestions = [];

  for (const top of tops) {
    for (const bottom of bottoms) {
      let totalScore = 0;
      const reasons = [];

      const colorScore = scoreColorCombo(top, bottom);
      totalScore += colorScore;
      if (colorScore >= 9) reasons.push("great color match");

      const styleScore = scoreStyleMatch(top, bottom);
      totalScore += styleScore;
      if (styleScore >= 6) reasons.push("matching styles");

      const seasonScore = scoreSeasonMatch(top, bottom);
      totalScore += seasonScore;

      const occasionScore = scoreOccasionMatch(top, bottom);
      totalScore += occasionScore;

      const formalityScore = scoreFormality(top, bottom);
      totalScore += formalityScore;
      if (formalityScore >= 6) reasons.push("similar formality");

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

      if (bestShoes.item) {
        totalScore += bestShoes.score * 0.3;
        if (scoreColorCombo(top, bestShoes.item) >= 9) reasons.push("shoes match top");
      }
      if (bestAcc.item) {
        totalScore += bestAcc.score * 0.2;
        if (scoreColorCombo(bottom, bestAcc.item) >= 9) reasons.push("accessory ties together");
      }

      const warmthScore = scoreWarmth(top, bottom, season);
      totalScore += warmthScore;

      if (totalScore < 15) continue;

      const garmentIds = [top.id, bottom.id];
      if (bestShoes.item) garmentIds.push(bestShoes.item.id);
      if (bestAcc.item) garmentIds.push(bestAcc.item.id);

      const nameParts = [top.name, bottom.name];
      if (bestShoes.item) nameParts.push(bestShoes.item.name);

      let occasionLabel = "casual";
      const avgFormality = ((top.formality_level || 3) + (bottom.formality_level || 3)) / 2;
      if (avgFormality >= 4) occasionLabel = "formal";
      else if (avgFormality >= 3) occasionLabel = "smart casual";
      else if (avgFormality <= 1.5) occasionLabel = "sport";

      suggestions.push({
        name: nameParts.slice(0, 2).join(" + "),
        occasion: occasionLabel,
        garmentIds,
        score: Math.round(totalScore * 100) / 100,
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
    const key = s.garmentIds.sort().join(",");
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
    hasSupabase: Boolean(SUPABASE_URL),
    hasGemini: Boolean(GEMINI_API_KEY),
    ready: Boolean(SUPABASE_URL),
  });
}

async function apiGetGarments(req, res) {
  const { data, error } = await supabase
    .from("items")
    .select("*")
    .eq("active", true)
    .order("created_at", { ascending: false });
  if (error) throw error;

  json(res, 200, (data || []).map(g => ({
    id: g.id,
    name: g.name,
    part: g.part,
    color: g.color,
    secondaryColor: g.secondary_color,
    palette: g.palette || [],
    tags: g.tags || [],
    image: g.image_url,
    thumbnail: g.thumbnail_url || g.image_url,
    modeledImage: g.modeled_url || null,
    gender: g.gender,
    style: g.style || [],
    season: g.season || [],
    occasion: g.occasion || [],
    material: g.material,
    pattern: g.pattern,
    fit: g.fit,
    neckline: g.neckline,
    length: g.length,
    details: g.details || [],
    weather: g.weather || [],
    warmthLevel: g.warmth_level,
    formalityLevel: g.formality_level,
    trendScore: g.trend_score,
    brand: g.brand,
    description: g.description,
  })));
}

async function apiGetGarment(req, res, id) {
  const { data, error } = await supabase
    .from("items")
    .select("*")
    .eq("id", id)
    .single();
  if (error || !data) return json(res, 404, { error: "Not found" });

  json(res, 200, {
    id: data.id,
    name: data.name,
    part: data.part,
    color: data.color,
    secondaryColor: data.secondary_color,
    palette: data.palette || [],
    tags: data.tags || [],
    image: data.image_url,
    thumbnail: data.thumbnail_url || data.image_url,
    modeledImage: data.modeled_url || null,
    gender: data.gender,
    style: data.style || [],
    season: data.season || [],
    occasion: data.occasion || [],
    material: data.material,
    pattern: data.pattern,
    fit: data.fit,
    neckline: data.neckline,
    length: data.length,
    details: data.details || [],
    weather: data.weather || [],
    warmthLevel: data.warmth_level,
    formalityLevel: data.formality_level,
    trendScore: data.trend_score,
    brand: data.brand,
    description: data.description,
  });
}

async function apiUpdateGarment(req, res, id) {
  const input = await parseBody(req);
  const update = {
    name: (input.name || "").trim().slice(0, 120) || "New piece",
    part: input.part || "upperbody",
    color: input.color || null,
    secondary_color: input.secondaryColor || null,
    palette: Array.isArray(input.palette) ? input.palette : [],
    tags: Array.isArray(input.tags) ? input.tags : [],
    gender: input.gender || null,
    style: input.style || [],
    season: input.season || [],
    occasion: input.occasion || [],
    material: input.material || null,
    pattern: input.pattern || null,
    fit: input.fit || null,
    neckline: input.neckline || null,
    length: input.length || null,
    details: input.details || [],
    weather: input.weather || [],
    warmth_level: input.warmthLevel || null,
    formality_level: input.formalityLevel || null,
    trend_score: input.trendScore || null,
    brand: input.brand || null,
    description: input.description || null,
  };

  const { error } = await supabase.from("items").update(update).eq("id", id);
  if (error) throw error;

  const { data } = await supabase.from("items").select("*").eq("id", id).single();
  json(res, 200, {
    id: data.id, name: data.name, part: data.part, color: data.color,
    secondaryColor: data.secondary_color, palette: data.palette || [], tags: data.tags || [],
    image: data.image_url, thumbnail: data.thumbnail_url || data.image_url,
    modeledImage: data.modeled_url || null,
    gender: data.gender, style: data.style || [], season: data.season || [],
    occasion: data.occasion || [], material: data.material, pattern: data.pattern,
    fit: data.fit, neckline: data.neckline, length: data.length,
    details: data.details || [], weather: data.weather || [],
    warmthLevel: data.warmth_level, formalityLevel: data.formality_level,
    trendScore: data.trend_score, brand: data.brand, description: data.description,
  });
}

async function apiDeleteGarment(req, res, id) {
  const { error } = await supabase.from("items").update({ active: false }).eq("id", id);
  if (error) throw error;
  json(res, 200, { deleted: true, id });
}

async function apiImportGarment(req, res) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  const { imageBase64, mimeType = "image/png" } = body;

  if (!imageBase64) return json(res, 400, { error: "imageBase64 required" });

  const metadata = await analyzeGarmentWithGemini(imageBase64, mimeType);

  const slug = `garment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const imagePath = `${UPLOAD_DIR}/${slug}.png`;

  const buffer = Buffer.from(imageBase64, "base64");
  writeFileSync(imagePath, buffer);

  const { data, error } = await supabase
    .from("items")
    .insert({
      slug,
      name: metadata.name || "Imported piece",
      part: metadata.part || "upperbody",
      color: metadata.color || null,
      secondary_color: metadata.secondary_color || null,
      palette: metadata.palette || [],
      tags: metadata.tags || [],
      image_url: `/api/library/${slug}.png`,
      thumbnail_url: `/api/library/${slug}.png`,
      gender: metadata.gender || null,
      style: metadata.style || [],
      season: metadata.season || [],
      occasion: metadata.occasion || [],
      material: metadata.material || null,
      pattern: metadata.pattern || null,
      fit: metadata.fit || null,
      neckline: metadata.neckline || null,
      length: metadata.length || null,
      details: metadata.details || [],
      weather: metadata.weather || [],
      warmth_level: metadata.warmth_level || null,
      formality_level: metadata.formality_level || null,
      trend_score: metadata.trend_score || null,
      brand: metadata.brand || null,
      description: metadata.description || null,
    })
    .select()
    .single();

  if (error) throw error;

  json(res, 201, {
    id: data.id, name: data.name, part: data.part, color: data.color,
    secondaryColor: data.secondary_color, palette: data.palette || [], tags: data.tags || [],
    image: data.image_url, thumbnail: data.thumbnail_url || data.image_url,
    modeledImage: null,
    gender: data.gender, style: data.style || [], season: data.season || [],
    occasion: data.occasion || [], material: data.material, pattern: data.pattern,
    fit: data.fit, neckline: data.neckline, length: data.length,
    details: data.details || [], weather: data.weather || [],
    warmthLevel: data.warmth_level, formalityLevel: data.formality_level,
    trendScore: data.trend_score, brand: data.brand, description: data.description,
    metadata,
  });
}

async function apiGetOutfits(req, res) {
  const { data: outfits, error } = await supabase
    .from("outfits")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;

  const result = await Promise.all((outfits || []).map(async o => {
    const { data: items } = await supabase
      .from("outfit_items")
      .select("item_id, position")
      .eq("outfit_id", o.id)
      .order("position");
    return {
      id: o.id, name: o.name, occasion: o.occasion, season: o.season,
      isFavorite: o.is_favorite, uses: o.uses,
      garmentIds: (items || []).map(i => i.item_id),
      weather: o.weather || [], formalityLevel: o.formality_level,
      style: o.style || [], score: o.score,
      createdAt: o.created_at, updatedAt: o.updated_at,
    };
  }));

  json(res, 200, result);
}

async function apiCreateOutfit(req, res) {
  const input = await parseBody(req);
  const { data: outfit, error } = await supabase
    .from("outfits")
    .insert({
      name: input.name || "New outfit",
      occasion: input.occasion || null,
      season: input.season || null,
      weather: input.weather || [],
      formality_level: input.formalityLevel || null,
      style: input.style || [],
      score: input.score || null,
    })
    .select()
    .single();
  if (error) throw error;

  if (Array.isArray(input.garmentIds) && input.garmentIds.length) {
    await supabase.from("outfit_items").insert(
      input.garmentIds.map((gid, i) => ({ outfit_id: outfit.id, garment_id: gid, position: i }))
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
  const input = await parseBody(req);
  await supabase.from("outfits").update({
    name: input.name,
    occasion: input.occasion || null,
    season: input.season || null,
    weather: input.weather || [],
    formality_level: input.formalityLevel || null,
    style: input.style || [],
    score: input.score || null,
  }).eq("id", id);

  if ("garmentIds" in input) {
    await supabase.from("outfit_items").delete().eq("outfit_id", id);
    if (Array.isArray(input.garmentIds) && input.garmentIds.length) {
      await supabase.from("outfit_items").insert(
        input.garmentIds.map((gid, i) => ({ outfit_id: id, garment_id: gid, position: i }))
      );
    }
  }

  const { data: updated } = await supabase.from("outfits").select("*").eq("id", id).single();
  const { data: items } = await supabase.from("outfit_items").select("item_id").eq("outfit_id", id);
  json(res, 200, {
    id: updated.id, name: updated.name, occasion: updated.occasion, season: updated.season,
    garmentIds: (items || []).map(i => i.item_id), weather: updated.weather || [],
    formalityLevel: updated.formality_level, style: updated.style || [],
    createdAt: updated.created_at, updatedAt: updated.updated_at,
  });
}

async function apiDeleteOutfit(req, res, id) {
  await supabase.from("outfit_items").delete().eq("outfit_id", id);
  await supabase.from("outfits").delete().eq("id", id);
  json(res, 200, { deleted: true, id });
}

async function apiSuggestOutfits(req, res) {
  const url = new URL(req.url, "http://localhost");
  const season = url.searchParams.get("season") || "mild";
  const occasion = url.searchParams.get("occasion") || "casual";

  const { data: items, error } = await supabase
    .from("items")
    .select("*")
    .eq("active", true);
  if (error) throw error;

  if (!items?.length) return json(res, 200, { outfits: [], message: "Add garments first" });

  const suggestions = generateOutfitSuggestions(items, { season, occasion });
  json(res, 200, { outfits: suggestions });
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
    json(res, err.status || 500, { error: err.message || "Internal server error" });
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
  console.log(`[wardrobe] Supabase: ${SUPABASE_URL ? "connected" : "MISSING"}`);
  console.log(`[wardrobe] Gemini: ${GEMINI_API_KEY ? "configured" : "MISSING"}`);
});

process.on("SIGTERM", () => server.close());
process.on("SIGINT", () => server.close());
