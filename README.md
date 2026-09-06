# Mi Closet

Webapp móvil para gestionar tu armario digital y crear outfits. Mobile-first responsive.

Basado en [tandpfun/wardrobe](https://github.com/tandpfun/wardrobe), adaptado con:

- **Supabase Postgres** como base de datos (en lugar de `data/library.json`)
- **Pestaña Outfits** con collage manual y sugerencias automáticas por reglas (sin IA)
- **Mobile-first** responsive

## Stack

- Vite + React 19
- Node `server.mjs` como servidor productivo (Vite middlewareMode)
- Supabase (Postgres + opcionalmente Storage para imágenes)

## Configuración rápida

```bash
git clone https://github.com/EloiGP10/wardrobe.git
cd wardrobe
npm install
cp .env.example .env
# Edita .env con SUPABASE_URL y SUPABASE_SERVICE_KEY
npm run dev
```

## Variables de entorno

| Variable | Descripción |
| --- | --- |
| `SUPABASE_URL` | URL del proyecto Supabase |
| `SUPABASE_SERVICE_KEY` | Clave service-role (no la anon) |
| `WARDROBE_STORAGE_BUCKET` | Bucket de Storage (opcional, por defecto `wardrobe`) |
| `OPENAI_API_KEY` | Opcional. Activa el import con detección de prendas |
| `PORT` | Puerto del servidor (default 3000) |

## Esquema de base de datos

Aplicar `db/schema.sql` en el SQL editor de Supabase. Crea 4 tablas:

- `garments` — prendas individuales
- `import_jobs` — trabajos de import con OpenAI (futuro)
- `outfits` — outfits compuestos
- `outfit_items` — relación N:M entre outfits y garments

## Funcionalidades

- **Closet**: galería filtrada por categoría, edición de cada prenda (nombre, color, detalles)
- **Import (opcional)**: detección de prendas con OpenAI desde una foto (requiere `OPENAI_API_KEY`)
- **Outfits**:
  - Crear outfits manualmente eligiendo prendas
  - Sugerencias automáticas basadas en reglas de compatibilidad (color, formalidad, tipo)
  - Modo collage con previsualización de la combinación

## Despliegue

Configurado para Coolify con build pack `nixpacks`:

- Build: `npm run build`
- Start: `node server.mjs`
- Puerto interno: 3000

Variables requeridas en Coolify: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`.

## Licencia

MIT