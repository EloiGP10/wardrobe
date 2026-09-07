import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import pg from "pg";
import { removeBackground } from "../lib/matting.mjs";

const DATA_DIR = resolve(process.cwd(), "data");
const UPLOAD_DIR = resolve(DATA_DIR, "imported");
const SUPABASE_PUBLIC_URL = (process.env.SUPABASE_PUBLIC_URL || "https://supabase-eloigfamily.duckdns.org").replace(/\/+$/, "");
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || "";
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || "wardrobe";

const onlyUser = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1];
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });

async function uploadToStorage(filename, buffer, contentType = "image/png") {
  if (!SUPABASE_SERVICE_KEY) return false;
  try {
    const res = await fetch(`${SUPABASE_PUBLIC_URL}/storage/v1/object/${SUPABASE_BUCKET}/${filename}`, {
      method: "POST",
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, "Content-Type": contentType },
      body: buffer,
    });
    return res.ok;
  } catch (err) {
    console.error(`[storage] upload ${filename}: ${err.message}`);
    return false;
  }
}

async function readLocalOrStorage(filename) {
  const local = resolve(UPLOAD_DIR, filename);
  if (existsSync(local)) return readFileSync(local);
  if (!SUPABASE_SERVICE_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_PUBLIC_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${filename}`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
    });
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  } catch { return null; }
}

async function main() {
  if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });

  const where = onlyUser ? "WHERE active = true AND user_id = $1" : "WHERE active = true";
  const params = onlyUser ? [onlyUser] : [];
  const items = await db.query(`SELECT id, name, part, image_url FROM items ${where}`, params);

  console.log(`[reprocess] ${items.rows.length} items to check`);
  let ok = 0, skip = 0, fail = 0;

  for (const row of items.rows) {
    const filename = row.image_url?.split("/").pop();
    if (!filename) { console.log(`  - ${row.id} no image`); fail++; continue; }

    const src = await readLocalOrStorage(filename);
    if (!src) { console.log(`  ! ${row.id} could not read image`); fail++; continue; }

    const out = await removeBackground(src);
    if (!out) { console.log(`  ! ${row.id} bg-remove returned nothing`); fail++; continue; }

    try {
      writeFileSync(resolve(UPLOAD_DIR, filename), out);
      await uploadToStorage(filename, out);
      ok++;
      console.log(`  + ${row.id} ${row.name} processed`);
    } catch (e) {
      console.log(`  ! ${row.id} ${e.message}`);
      fail++;
    }
  }

  console.log(`[reprocess] done: ${ok} ok, ${skip} skipped, ${fail} failed`);
  await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
