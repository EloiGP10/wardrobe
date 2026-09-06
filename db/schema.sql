-- Wardrobe schema for Supabase Postgres
-- Each table has a single 'default' row (id=1) so the app behaves like a single-user wardrobe.

create table if not exists public.garments (
  id text primary key,
  name text not null default 'New piece',
  part text not null default 'upperbody'
    check (part in ('upperbody', 'wholebody_up', 'lowerbody', 'accessories_up', 'shoes')),
  color text not null default '#d8d0c2',
  secondary_color text,
  palette jsonb not null default '[]'::jsonb,
  tags jsonb not null default '[]'::jsonb,
  image_path text not null,
  thumbnail_path text not null,
  modeled_image_path text,
  import_job_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists garments_part_idx on public.garments (part);
create index if not exists garments_updated_at_idx on public.garments (updated_at desc);

create table if not exists public.import_jobs (
  id uuid primary key,
  status text not null default 'active'
    check (status in ('active', 'complete', 'failed')),
  metadata jsonb not null default '{}'::jsonb,
  stages jsonb not null default '{}'::jsonb,
  original_path text,
  crop_path text,
  garment_path text,
  modeled_path text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists import_jobs_status_idx on public.import_jobs (status);
create index if not exists import_jobs_created_at_idx on public.import_jobs (created_at desc);

create table if not exists public.outfits (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'New outfit',
  occasion text,
  season text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists outfits_updated_at_idx on public.outfits (updated_at desc);

create table if not exists public.outfit_items (
  outfit_id uuid not null references public.outfits (id) on delete cascade,
  garment_id text not null references public.garments (id) on delete cascade,
  position smallint not null default 0,
  primary key (outfit_id, garment_id)
);

create index if not exists outfit_items_garment_idx on public.outfit_items (garment_id);

create or replace function public.touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists garments_touch on public.garments;
create trigger garments_touch before update on public.garments
  for each row execute function public.touch_updated_at();

drop trigger if exists import_jobs_touch on public.import_jobs;
create trigger import_jobs_touch before update on public.import_jobs
  for each row execute function public.touch_updated_at();

drop trigger if exists outfits_touch on public.outfits;
create trigger outfits_touch before update on public.outfits
  for each row execute function public.touch_updated_at();