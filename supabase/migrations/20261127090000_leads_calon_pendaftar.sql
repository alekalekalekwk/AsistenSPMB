-- Data calon pendaftar yang minta dihubungi panitia lewat WhatsApp (form di widget Sigi).
-- Hanya backend (service role) yang membaca dan menulis: tidak ada grant untuk anon/authenticated.
create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  name text not null check (char_length(name) between 2 and 80),
  whatsapp text not null check (whatsapp ~ '^62[0-9]{8,13}$'),
  interest text check (interest is null or char_length(interest) <= 80),
  status text not null default 'baru' check (status in ('baru', 'dihubungi', 'mendaftar', 'batal')),
  source text not null default 'widget' check (source in ('widget', 'embed', 'kiosk')),
  conversation_id uuid,
  visitor_session_id uuid,
  consent_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_leads_school_created on public.leads (school_id, created_at desc);
create index if not exists idx_leads_school_whatsapp on public.leads (school_id, whatsapp, created_at desc);

alter table public.leads enable row level security;
revoke all on public.leads from anon, authenticated;
