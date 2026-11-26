-- Migrasi terpadu: menggabungkan skema SaaS Multi-Sekolah (Blueprint Fase 1)
-- dengan skema Analytics & Data Collection Sigi tanpa menghapus data yang sudah ada.
-- Perubahan utama:
-- 1. Mengubah schools.id dari text menjadi uuid + kolom slug text UNIQUE.
-- 2. Menambah kolom SaaS pada schools (plan, chat_quota, chat_used, theme, greeting, suggestions, voice_*).
-- 3. Menambah tabel school_members, school_pages, school_documents, api_keys.
-- 4. Menambah api_key_id & endpoint pada llm_requests + view usage_logs untuk kompatibilitas Blueprint.
-- 5. Menambah kebijakan RLS per school_members + trigger pelindung plan/kuota + RPC workspace & kuota.

-- 1. Hapus view, constraint, dan index lama yang bergantung pada school_id text.
drop view if exists public.v_chat_qa;
drop view if exists public.v_unanswered_questions;
drop view if exists public.v_hourly_traffic_wib;

drop index if exists public.idx_conversations_school_started;
drop index if exists public.idx_conversations_school_period;
drop index if exists public.idx_messages_analytics;
drop index if exists public.idx_messages_unanswered;
drop index if exists public.idx_messages_topic;
drop index if exists public.idx_llm_requests_school_created;
drop index if exists public.idx_widget_events_school_created;

alter table public.conversations drop constraint if exists conversations_school_id_fkey;
alter table public.messages drop constraint if exists messages_school_id_fkey;
alter table public.llm_requests drop constraint if exists llm_requests_school_id_fkey;
alter table public.widget_events drop constraint if exists widget_events_school_id_fkey;

-- 2. Tambah kolom baru Blueprint pada public.schools & isi slug dari id lama.
alter table public.schools
  add column if not exists new_id uuid not null default gen_random_uuid(),
  add column if not exists slug text,
  add column if not exists plan text not null default 'trial',
  add column if not exists chat_quota integer not null default 50,
  add column if not exists chat_used integer not null default 0,
  add column if not exists theme jsonb not null default '{"primary":"#0f766e","onPrimary":"#ffffff","accent":"#bef264","onAccent":"#0b1f1d"}'::jsonb,
  add column if not exists greeting text not null default 'Halo! Ada yang bisa saya bantu seputar SPMB?',
  add column if not exists suggestions jsonb not null default '[]'::jsonb,
  add column if not exists voice_enabled boolean not null default false,
  add column if not exists voice_id text not null default 'flux-fitri-id',
  add column if not exists voice_expressivity integer not null default 1;

alter table public.schools drop constraint if exists schools_plan_check;
alter table public.schools add constraint schools_plan_check check (plan in ('trial', 'active', 'suspended'));
alter table public.schools drop constraint if exists schools_chat_quota_check;
alter table public.schools add constraint schools_chat_quota_check check (chat_quota >= 0);
alter table public.schools drop constraint if exists schools_chat_used_check;
alter table public.schools add constraint schools_chat_used_check check (chat_used >= 0);
alter table public.schools drop constraint if exists schools_voice_expressivity_check;
alter table public.schools add constraint schools_voice_expressivity_check check (voice_expressivity between -2 and 2);

update public.schools
set slug = id
where slug is null;

update public.schools
set plan = 'active',
    chat_quota = 10000,
    theme = '{"primary":"#001e42","onPrimary":"#ffffff","accent":"#e3ce0f","onAccent":"#001e42"}'::jsonb,
    greeting = 'Halo! Aku Asisten SPMB SMK Wikrama Bogor. Mau tanya soal pendaftaran, jurusan, atau ekskul?',
    suggestions = '["Cara daftarnya gimana?","Ada jurusan apa aja?","Berkas apa yang perlu disiapin?"]'::jsonb,
    voice_enabled = true,
    voice_id = 'flux-fitri-id',
    voice_expressivity = 1
where slug = 'wikrama';

-- 3. Migrasikan kolom school_id di 4 tabel analytics dari text ke uuid tanpa kehilangan data.
alter table public.conversations add column if not exists school_uuid uuid;
update public.conversations c
set school_uuid = s.new_id
from public.schools s
where s.id = c.school_id;
alter table public.conversations alter column school_uuid set not null;
alter table public.conversations drop column school_id;
alter table public.conversations rename column school_uuid to school_id;

alter table public.messages add column if not exists school_uuid uuid;
update public.messages m
set school_uuid = s.new_id
from public.schools s
where s.id = m.school_id;
alter table public.messages alter column school_uuid set not null;
alter table public.messages drop column school_id;
alter table public.messages rename column school_uuid to school_id;

alter table public.llm_requests add column if not exists school_uuid uuid;
update public.llm_requests l
set school_uuid = s.new_id
from public.schools s
where s.id = l.school_id;
alter table public.llm_requests alter column school_uuid set not null;
alter table public.llm_requests drop column school_id;
alter table public.llm_requests rename column school_uuid to school_id;

alter table public.widget_events add column if not exists school_uuid uuid;
update public.widget_events e
set school_uuid = s.new_id
from public.schools s
where s.id = e.school_id;
alter table public.widget_events alter column school_uuid set not null;
alter table public.widget_events drop column school_id;
alter table public.widget_events rename column school_uuid to school_id;

-- 4. Jadikan new_id sebagai PK uuid pada public.schools dan slug sebagai UNIQUE.
alter table public.schools drop constraint if exists schools_pkey;
alter table public.schools drop column id;
alter table public.schools rename column new_id to id;
alter table public.schools alter column id set default gen_random_uuid();
alter table public.schools add primary key (id);
alter table public.schools alter column slug set not null;
alter table public.schools drop constraint if exists schools_slug_key;
alter table public.schools add constraint schools_slug_key unique (slug);

-- 5. Buat tabel SaaS baru sesuai Blueprint (school_members, school_pages, school_documents, api_keys).
create table if not exists public.school_members (
  school_id uuid not null references public.schools(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'editor' check (role in ('owner', 'editor')),
  created_at timestamptz not null default now(),
  primary key (school_id, user_id)
);

create table if not exists public.school_pages (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  title text not null,
  body text not null default '',
  sort_order integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.school_documents (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  file_name text not null,
  page_count integer not null default 0 check (page_count >= 0),
  extracted_text text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  kind text not null check (kind in ('publishable', 'secret')),
  label text not null default 'Default',
  key_prefix text not null,
  key_value text,
  key_hash text not null unique,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint api_keys_secret_no_plaintext check (kind = 'publishable' or key_value is null)
);

-- 6. Hubungkan ulang FK analytics & perluas llm_requests untuk api_key_id + endpoint.
alter table public.conversations
  add constraint conversations_school_id_fkey foreign key (school_id) references public.schools(id) on delete cascade;

alter table public.messages
  add constraint messages_school_id_fkey foreign key (school_id) references public.schools(id) on delete cascade;

alter table public.llm_requests
  add column if not exists api_key_id uuid references public.api_keys(id) on delete set null,
  add column if not exists endpoint text not null default 'chat';

alter table public.llm_requests drop constraint if exists llm_requests_endpoint_check;
alter table public.llm_requests add constraint llm_requests_endpoint_check check (endpoint in ('chat', 'speak', 'voice_token'));
alter table public.llm_requests
  add constraint llm_requests_school_id_fkey foreign key (school_id) references public.schools(id) on delete cascade;

alter table public.widget_events
  add constraint widget_events_school_id_fkey foreign key (school_id) references public.schools(id) on delete cascade;

-- 7. Indeks lengkap untuk analytics, CMS sekolah, dan lookup API key cepat.
create index if not exists idx_conversations_school_started
  on public.conversations (school_id, started_at desc);

create index if not exists idx_conversations_school_period
  on public.conversations (school_id, period_label, started_at desc);

create index if not exists idx_messages_analytics
  on public.messages (school_id, created_at desc)
  where is_filler = false;

create index if not exists idx_messages_unanswered
  on public.messages (school_id, created_at desc)
  where role = 'assistant' and is_unanswered = true and is_filler = false;

create index if not exists idx_messages_topic
  on public.messages (school_id, topic, created_at desc)
  where role = 'user' and is_filler = false;

create index if not exists idx_llm_requests_school_created
  on public.llm_requests (school_id, created_at desc);

create index if not exists idx_llm_requests_api_key_created
  on public.llm_requests (api_key_id, created_at desc)
  where api_key_id is not null;

create index if not exists idx_widget_events_school_created
  on public.widget_events (school_id, event_name, created_at desc);

create index if not exists idx_school_members_user
  on public.school_members (user_id, school_id);

create index if not exists idx_school_pages_school_sort
  on public.school_pages (school_id, sort_order asc, updated_at asc);

create index if not exists idx_school_documents_school_created
  on public.school_documents (school_id, created_at desc);

create index if not exists idx_api_keys_school_active
  on public.api_keys (school_id, kind)
  where revoked_at is null;

-- 8. Views analitik + view usage_logs (kompatibilitas Blueprint di atas llm_requests).
create or replace view public.v_chat_qa
with (security_invoker = true) as
select
  a.id as assistant_message_id,
  a.school_id,
  s.slug as school_slug,
  a.conversation_id,
  a.channel,
  u.input_source,
  a.period_label,
  coalesce(u.topic, a.topic, 'lainnya') as topic,
  u.content as question,
  a.content as answer,
  a.is_unanswered,
  (coalesce(u.had_pii_redacted, false) or a.had_pii_redacted) as had_pii_redacted,
  a.created_at
from public.messages a
join public.schools s on s.id = a.school_id
left join public.messages u on u.id = a.paired_user_message_id
where a.role = 'assistant'
  and a.is_filler = false;

create or replace view public.v_unanswered_questions
with (security_invoker = true) as
select
  a.id as assistant_message_id,
  a.school_id,
  s.slug as school_slug,
  a.conversation_id,
  a.channel,
  a.period_label,
  coalesce(u.topic, a.topic, 'lainnya') as topic,
  u.content as question,
  a.content as answer,
  a.created_at
from public.messages a
join public.schools s on s.id = a.school_id
left join public.messages u on u.id = a.paired_user_message_id
where a.role = 'assistant'
  and a.is_unanswered = true
  and a.is_filler = false;

create or replace view public.v_hourly_traffic_wib
with (security_invoker = true) as
select
  m.school_id,
  s.slug as school_slug,
  m.period_label,
  extract(hour from (m.created_at at time zone 'Asia/Jakarta'))::integer as hour_wib,
  count(*)::integer as question_count
from public.messages m
join public.schools s on s.id = m.school_id
where m.role = 'user'
  and m.is_filler = false
group by m.school_id, s.slug, m.period_label, extract(hour from (m.created_at at time zone 'Asia/Jakarta'));

create or replace view public.usage_logs
with (security_invoker = true) as
select
  id,
  school_id,
  api_key_id,
  endpoint,
  total_tokens,
  http_status as status_code,
  created_at
from public.llm_requests;

-- 9. Trigger keamanan & timestamp otomatis.
create or replace function public.guard_schools_sensitive_columns()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user in ('authenticated', 'anon') then
    if new.id is distinct from old.id
       or new.plan is distinct from old.plan
       or new.chat_quota is distinct from old.chat_quota
       or new.chat_used is distinct from old.chat_used then
      raise exception 'Kolom plan dan kuota hanya dapat diubah oleh server Sigi.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_schools_sensitive on public.schools;
create trigger trg_guard_schools_sensitive
before update on public.schools
for each row execute function public.guard_schools_sensitive_columns();

create or replace function public.touch_school_page_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_touch_school_pages on public.school_pages;
create trigger trg_touch_school_pages
before update on public.school_pages
for each row execute function public.touch_school_page_updated_at();

-- 10. Helper & Kebijakan RLS (anon tetap deny-all; authenticated khusus anggota school_members).
create or replace function public.is_school_member(p_school_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.school_members m
    where m.school_id = p_school_id
      and m.user_id = auth.uid()
  );
$$;

alter table public.school_members enable row level security;
alter table public.school_pages enable row level security;
alter table public.school_documents enable row level security;
alter table public.api_keys enable row level security;

revoke all on public.schools from anon, authenticated;
revoke all on public.school_members from anon, authenticated;
revoke all on public.school_pages from anon, authenticated;
revoke all on public.school_documents from anon, authenticated;
revoke all on public.api_keys from anon, authenticated;
revoke all on public.conversations from anon, authenticated;
revoke all on public.messages from anon, authenticated;
revoke all on public.llm_requests from anon, authenticated;
revoke all on public.widget_events from anon, authenticated;
revoke all on public.v_chat_qa from anon, authenticated;
revoke all on public.v_unanswered_questions from anon, authenticated;
revoke all on public.v_hourly_traffic_wib from anon, authenticated;
revoke all on public.usage_logs from anon, authenticated;

grant select, update on public.schools to authenticated;
grant select on public.school_members to authenticated;
grant select, insert, update, delete on public.school_pages to authenticated;
grant select, insert, update, delete on public.school_documents to authenticated;
grant select (id, school_id, kind, label, key_prefix, key_value, last_used_at, revoked_at, created_at)
  on public.api_keys to authenticated;
grant select on public.conversations to authenticated;
grant select on public.messages to authenticated;
grant select on public.llm_requests to authenticated;
grant select on public.widget_events to authenticated;
grant select on public.v_chat_qa to authenticated;
grant select on public.v_unanswered_questions to authenticated;
grant select on public.v_hourly_traffic_wib to authenticated;
grant select on public.usage_logs to authenticated;

drop policy if exists schools_member_select on public.schools;
create policy schools_member_select on public.schools
  for select to authenticated
  using (public.is_school_member(id));

drop policy if exists schools_member_update on public.schools;
create policy schools_member_update on public.schools
  for update to authenticated
  using (public.is_school_member(id))
  with check (public.is_school_member(id));

drop policy if exists school_members_select on public.school_members;
create policy school_members_select on public.school_members
  for select to authenticated
  using (user_id = auth.uid() or public.is_school_member(school_id));

drop policy if exists school_pages_member_all on public.school_pages;
create policy school_pages_member_all on public.school_pages
  for all to authenticated
  using (public.is_school_member(school_id))
  with check (public.is_school_member(school_id));

drop policy if exists school_documents_member_all on public.school_documents;
create policy school_documents_member_all on public.school_documents
  for all to authenticated
  using (public.is_school_member(school_id))
  with check (public.is_school_member(school_id));

drop policy if exists api_keys_member_select on public.api_keys;
create policy api_keys_member_select on public.api_keys
  for select to authenticated
  using (public.is_school_member(school_id));

drop policy if exists conversations_member_select on public.conversations;
create policy conversations_member_select on public.conversations
  for select to authenticated
  using (public.is_school_member(school_id));

drop policy if exists messages_member_select on public.messages;
create policy messages_member_select on public.messages
  for select to authenticated
  using (public.is_school_member(school_id));

drop policy if exists llm_requests_member_select on public.llm_requests;
create policy llm_requests_member_select on public.llm_requests
  for select to authenticated
  using (public.is_school_member(school_id));

drop policy if exists widget_events_member_select on public.widget_events;
create policy widget_events_member_select on public.widget_events
  for select to authenticated
  using (public.is_school_member(school_id));

-- 11. RPC baru untuk SaaS (onboarding 6 halaman template, validasi API key, dan kuota atomik).
create or replace function public.create_school_workspace(
  p_user_id uuid,
  p_name text,
  p_slug text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text := nullif(trim(p_name), '');
  v_slug text := lower(regexp_replace(coalesce(trim(p_slug), ''), '[^a-z0-9-]+', '-', 'g'));
  v_school_id uuid;
begin
  if current_user = 'authenticated' and p_user_id is distinct from auth.uid() then
    raise exception 'Tidak boleh membuat workspace untuk user lain.';
  end if;
  if v_name is null or trim(both '-' from v_slug) = '' then
    raise exception 'Nama sekolah dan slug wajib diisi.';
  end if;
  v_slug := trim(both '-' from v_slug);

  insert into public.schools (name, slug, plan, chat_quota, chat_used)
  values (v_name, v_slug, 'trial', 50, 0)
  returning id into v_school_id;

  insert into public.school_members (school_id, user_id, role)
  values (v_school_id, p_user_id, 'owner');

  insert into public.school_pages (school_id, title, body, sort_order) values
    (v_school_id, 'Profil Sekolah', '- Nama resmi: ' || v_name || E'\n- Status: ...\n- Akreditasi: ...\n- Alamat: ...\n- Jam belajar: ...', 1),
    (v_school_id, 'Alur & Berkas SPMB', E'Periode aktif: ...\nLink pendaftaran: ...\n\nAlur pendaftaran:\n1. ...\n\nBerkas persyaratan:\n1. ...', 2),
    (v_school_id, 'Jurusan / Program Keahlian', E'1. Nama jurusan\n   - Materi yang dipelajari: ...\n   - Prospek karier: ...', 3),
    (v_school_id, 'Ekstrakurikuler & Kegiatan', E'- Ekskul umum: ...\n- Jadwal kegiatan: ...', 4),
    (v_school_id, 'Gelombang, Biaya, & Beasiswa', E'- Informasi gelombang pendaftaran: ...\n- Catatan biaya & beasiswa: ...', 5),
    (v_school_id, 'Kontak CS SPMB', E'- WhatsApp CS: ...\n- Jam operasional: ...\n- Alamat pendaftaran langsung: ...', 6);

  return jsonb_build_object(
    'ok', true,
    'school_id', v_school_id,
    'slug', v_slug,
    'plan', 'trial',
    'chat_quota', 50
  );
end;
$$;

create or replace function public.increment_school_usage(
  p_school_id uuid,
  p_api_key_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan text;
  v_quota integer;
  v_used integer;
begin
  update public.schools
  set chat_used = chat_used + 1
  where id = p_school_id
    and plan <> 'suspended'
    and chat_used < chat_quota
  returning plan, chat_quota, chat_used into v_plan, v_quota, v_used;

  if not found then
    select plan, chat_quota, chat_used
    into v_plan, v_quota, v_used
    from public.schools
    where id = p_school_id;

    return jsonb_build_object(
      'allowed', false,
      'reason', case
        when v_plan is null then 'school_not_found'
        when v_plan = 'suspended' then 'school_suspended'
        else 'quota_exceeded'
      end,
      'plan', v_plan,
      'chat_quota', coalesce(v_quota, 0),
      'chat_used', coalesce(v_used, 0)
    );
  end if;

  if p_api_key_id is not null then
    update public.api_keys
    set last_used_at = now()
    where id = p_api_key_id;
  end if;

  return jsonb_build_object(
    'allowed', true,
    'plan', v_plan,
    'chat_quota', v_quota,
    'chat_used', v_used
  );
end;
$$;

create or replace function public.resolve_api_key(p_key_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row record;
begin
  select
    k.id as api_key_id,
    k.kind,
    k.revoked_at,
    s.id as school_id,
    s.slug,
    s.name,
    s.plan,
    s.chat_quota,
    s.chat_used,
    s.theme,
    s.greeting,
    s.suggestions,
    s.voice_enabled,
    s.voice_id,
    s.voice_expressivity,
    s.allowed_origins,
    s.active_period_label
  into v_row
  from public.api_keys k
  join public.schools s on s.id = k.school_id
  where k.key_hash = p_key_hash
  limit 1;

  if not found then
    return jsonb_build_object('found', false);
  end if;

  return jsonb_build_object(
    'found', true,
    'revoked', v_row.revoked_at is not null,
    'api_key_id', v_row.api_key_id,
    'kind', v_row.kind,
    'school', jsonb_build_object(
      'id', v_row.school_id,
      'slug', v_row.slug,
      'name', v_row.name,
      'plan', v_row.plan,
      'chat_quota', v_row.chat_quota,
      'chat_used', v_row.chat_used,
      'theme', v_row.theme,
      'greeting', v_row.greeting,
      'suggestions', v_row.suggestions,
      'voice_enabled', v_row.voice_enabled,
      'voice_id', v_row.voice_id,
      'voice_expressivity', v_row.voice_expressivity,
      'allowed_origins', v_row.allowed_origins,
      'active_period_label', v_row.active_period_label
    )
  );
end;
$$;

-- 12. Perbarui RPC analytics agar kompatibel dengan schools.id (uuid) + lookup lewat slug atau uuid.
drop function if exists public.record_chat_turn(
  text, text, text, uuid, uuid, text, text, text, boolean, text, boolean, text, boolean, text, text, integer, integer, integer, integer, integer, text
);

create or replace function public.record_chat_turn(
  p_school_id text,
  p_school_name text,
  p_period_label text,
  p_conversation_id uuid,
  p_visitor_session_id uuid,
  p_channel text,
  p_input_source text,
  p_user_content text,
  p_user_redacted boolean,
  p_assistant_content text,
  p_assistant_redacted boolean,
  p_topic text,
  p_is_unanswered boolean,
  p_model text,
  p_netra_request_id text,
  p_prompt_tokens integer,
  p_completion_tokens integer,
  p_total_tokens integer,
  p_latency_ms integer,
  p_http_status integer,
  p_error_code text,
  p_api_key_id uuid default null,
  p_endpoint text default 'chat'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_school_ref text := coalesce(nullif(trim(p_school_id), ''), 'wikrama');
  v_school_name text := coalesce(nullif(trim(p_school_name), ''), v_school_ref);
  v_period text := coalesce(nullif(trim(p_period_label), ''), '2027-2028');
  v_school_uuid uuid;
  v_channel text := case when p_channel in ('chat', 'mic', 'call') then p_channel else 'chat' end;
  v_source text := case
    when p_input_source in ('typed', 'suggestion_chip', 'mic', 'call_voice', 'system_greeting', 'filler')
      then p_input_source
    else 'typed'
  end;
  v_endpoint text := case when p_endpoint in ('chat', 'speak', 'voice_token') then p_endpoint else 'chat' end;
  v_visitor uuid := coalesce(p_visitor_session_id, gen_random_uuid());
  v_user_msg_id uuid;
  v_assistant_msg_id uuid;
begin
  select id into v_school_uuid
  from public.schools
  where slug = v_school_ref
     or id::text = v_school_ref
  limit 1;

  if v_school_uuid is null then
    insert into public.schools (name, slug, active_period_label)
    values (v_school_name, lower(regexp_replace(v_school_ref, '[^a-z0-9-]+', '-', 'g')), v_period)
    on conflict (slug) do update
      set name = coalesce(nullif(excluded.name, ''), public.schools.name)
    returning id into v_school_uuid;
  end if;

  if p_conversation_id is not null
     and p_user_content is not null
     and p_assistant_content is not null then
    insert into public.conversations (
      id, school_id, visitor_session_id, channel, period_label, turn_count, has_unanswered
    )
    values (
      p_conversation_id, v_school_uuid, v_visitor, v_channel, v_period, 0, false
    )
    on conflict (id) do update
      set channel = case
            when excluded.channel = 'call' then 'call'
            else public.conversations.channel
          end,
          last_message_at = now(),
          ended_at = null;

    insert into public.messages (
      conversation_id, school_id, role, channel, input_source,
      content, had_pii_redacted, is_filler, topic, is_unanswered, tagged_by, period_label
    )
    values (
      p_conversation_id, v_school_uuid, 'user', v_channel, v_source,
      p_user_content, coalesce(p_user_redacted, false), false,
      coalesce(nullif(p_topic, ''), 'lainnya'), false, 'heuristic', v_period
    )
    returning id into v_user_msg_id;

    insert into public.messages (
      conversation_id, school_id, role, channel, input_source,
      content, had_pii_redacted, is_filler, topic, is_unanswered, tagged_by,
      paired_user_message_id, period_label
    )
    values (
      p_conversation_id, v_school_uuid, 'assistant', v_channel,
      case when v_channel = 'call' then 'call_voice' else 'typed' end,
      p_assistant_content, coalesce(p_assistant_redacted, false), false,
      coalesce(nullif(p_topic, ''), 'lainnya'), coalesce(p_is_unanswered, false), 'heuristic',
      v_user_msg_id, v_period
    )
    returning id into v_assistant_msg_id;

    update public.conversations
    set turn_count = turn_count + 1,
        has_unanswered = has_unanswered or coalesce(p_is_unanswered, false),
        last_message_at = now()
    where id = p_conversation_id;
  end if;

  insert into public.llm_requests (
    school_id, api_key_id, endpoint, conversation_id, message_id, netra_request_id, channel, model,
    prompt_tokens, completion_tokens, total_tokens, latency_ms, http_status, error_code
  )
  values (
    v_school_uuid, p_api_key_id, v_endpoint, p_conversation_id, v_assistant_msg_id, p_netra_request_id, v_channel,
    coalesce(nullif(p_model, ''), 'unknown'),
    p_prompt_tokens, p_completion_tokens, p_total_tokens,
    greatest(coalesce(p_latency_ms, 0), 0), coalesce(p_http_status, 0), p_error_code
  );

  return jsonb_build_object(
    'ok', true,
    'school_id', v_school_uuid,
    'user_message_id', v_user_msg_id,
    'assistant_message_id', v_assistant_msg_id
  );
end;
$$;

create or replace function public.record_widget_event(
  p_school_id text,
  p_school_name text,
  p_period_label text,
  p_conversation_id uuid,
  p_visitor_session_id uuid,
  p_event_name text,
  p_channel text,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_school_ref text := coalesce(nullif(trim(p_school_id), ''), 'wikrama');
  v_school_name text := coalesce(nullif(trim(p_school_name), ''), v_school_ref);
  v_period text := coalesce(nullif(trim(p_period_label), ''), '2027-2028');
  v_school_uuid uuid;
  v_visitor uuid := coalesce(p_visitor_session_id, gen_random_uuid());
  v_channel text := case when p_channel in ('chat', 'mic', 'call') then p_channel else null end;
  v_meta jsonb := coalesce(p_metadata, '{}'::jsonb);
  v_duration integer;
begin
  if p_event_name not in (
    'widget_opened', 'suggestion_clicked', 'mic_used', 'call_started', 'call_ended', 'conversation_reset'
  ) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_event');
  end if;

  select id into v_school_uuid
  from public.schools
  where slug = v_school_ref
     or id::text = v_school_ref
  limit 1;

  if v_school_uuid is null then
    insert into public.schools (name, slug, active_period_label)
    values (v_school_name, lower(regexp_replace(v_school_ref, '[^a-z0-9-]+', '-', 'g')), v_period)
    on conflict (slug) do update set name = public.schools.name
    returning id into v_school_uuid;
  end if;

  insert into public.widget_events (
    school_id, conversation_id, visitor_session_id, event_name, channel, metadata
  )
  values (
    v_school_uuid, p_conversation_id, v_visitor, p_event_name, v_channel, v_meta
  );

  if p_event_name = 'call_started' and p_conversation_id is not null then
    insert into public.conversations (
      id, school_id, visitor_session_id, channel, period_label, turn_count, has_unanswered
    )
    values (
      p_conversation_id, v_school_uuid, v_visitor, 'call', v_period, 0, false
    )
    on conflict (id) do update
      set channel = 'call',
          last_message_at = now(),
          ended_at = null;
  elsif p_event_name = 'call_ended' and p_conversation_id is not null then
    v_duration := case
      when (v_meta->>'duration_seconds') ~ '^\d+$'
        then (v_meta->>'duration_seconds')::integer
      else null
    end;
    update public.conversations
    set call_duration_seconds = case
          when v_duration is not null
            then greatest(coalesce(call_duration_seconds, 0), v_duration)
          else call_duration_seconds
        end,
        ended_at = now(),
        last_message_at = now()
    where id = p_conversation_id
      and school_id = v_school_uuid;
  elsif p_event_name = 'conversation_reset' and p_conversation_id is not null then
    update public.conversations
    set ended_at = coalesce(ended_at, now())
    where id = p_conversation_id
      and school_id = v_school_uuid;
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.get_school_analytics(
  p_school_id text,
  p_days integer default 30,
  p_period_label text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_school_ref text := coalesce(nullif(trim(p_school_id), ''), 'wikrama');
  v_school_uuid uuid;
  v_period text := nullif(trim(coalesce(p_period_label, '')), '');
  v_since timestamptz := case
    when p_days is not null and p_days > 0 then now() - make_interval(days => p_days)
    else null
  end;
  v_school jsonb;
  v_periods jsonb;
  v_summary jsonb;
  v_topics jsonb;
  v_popular jsonb;
  v_unanswered jsonb;
  v_hours jsonb;
  v_days jsonb;
  v_recent jsonb;
begin
  select id, jsonb_build_object(
    'id', id,
    'slug', slug,
    'name', name,
    'active_period_label', active_period_label,
    'plan', plan,
    'chat_quota', chat_quota,
    'chat_used', chat_used
  )
  into v_school_uuid, v_school
  from public.schools
  where slug = v_school_ref
     or id::text = v_school_ref
  limit 1;

  select coalesce(jsonb_agg(period_label order by period_label desc), '[]'::jsonb)
  into v_periods
  from (
    select distinct period_label
    from public.conversations
    where school_id = v_school_uuid
  ) p;

  with filtered_conv as (
    select *
    from public.conversations c
    where c.school_id = v_school_uuid
      and (v_since is null or c.started_at >= v_since)
      and (v_period is null or c.period_label = v_period)
  ),
  filtered_msg as (
    select *
    from public.messages m
    where m.school_id = v_school_uuid
      and m.is_filler = false
      and (v_since is null or m.created_at >= v_since)
      and (v_period is null or m.period_label = v_period)
  ),
  filtered_llm as (
    select l.*
    from public.llm_requests l
    left join public.conversations c on c.id = l.conversation_id
    where l.school_id = v_school_uuid
      and (v_since is null or l.created_at >= v_since)
      and (v_period is null or c.period_label is null or c.period_label = v_period)
  ),
  filtered_ev as (
    select *
    from public.widget_events e
    where e.school_id = v_school_uuid
      and (v_since is null or e.created_at >= v_since)
  ),
  counts as (
    select
      (select count(*)::integer from filtered_conv) as total_conversations,
      (select count(*)::integer from filtered_msg where role = 'user') as total_questions,
      (select count(*)::integer from filtered_msg where role = 'assistant' and is_unanswered = true) as unanswered_count,
      (select count(*)::integer from filtered_msg where role = 'user' and channel = 'chat') as chat_questions,
      (select count(*)::integer from filtered_msg where role = 'user' and channel = 'mic') as mic_questions,
      (select count(*)::integer from filtered_msg where role = 'user' and channel = 'call') as call_questions,
      (select count(*)::integer from filtered_conv where channel = 'call' or call_duration_seconds is not null) as total_calls,
      (select coalesce(round(avg(call_duration_seconds))::integer, 0) from filtered_conv where call_duration_seconds is not null) as avg_call_duration_seconds,
      (select count(*)::integer from filtered_ev where event_name = 'widget_opened') as widget_opens,
      (select count(*)::integer from filtered_ev where event_name = 'suggestion_clicked') as suggestion_clicks,
      (select coalesce(sum(total_tokens), 0)::bigint from filtered_llm) as total_tokens,
      (select coalesce(round(avg(latency_ms))::integer, 0) from filtered_llm where error_code is null) as avg_latency_ms,
      (select count(*)::integer from filtered_llm where error_code is not null) as error_count
  )
  select jsonb_build_object(
    'total_conversations', total_conversations,
    'total_questions', total_questions,
    'unanswered_count', unanswered_count,
    'unanswered_rate', case
      when total_questions > 0 then round((unanswered_count::numeric / total_questions::numeric) * 100, 1)
      else 0
    end,
    'channels', jsonb_build_object(
      'chat', chat_questions,
      'mic', mic_questions,
      'call', call_questions
    ),
    'total_calls', total_calls,
    'avg_call_duration_seconds', avg_call_duration_seconds,
    'widget_opens', widget_opens,
    'suggestion_clicks', suggestion_clicks,
    'total_tokens', total_tokens,
    'avg_latency_ms', avg_latency_ms,
    'error_count', error_count
  )
  into v_summary
  from counts;

  with q_topics as (
    select
      coalesce(u.topic, 'lainnya') as topic,
      count(*)::integer as question_count,
      count(*) filter (where a.is_unanswered = true)::integer as unanswered_count
    from public.messages u
    left join public.messages a on a.paired_user_message_id = u.id and a.role = 'assistant'
    where u.school_id = v_school_uuid
      and u.role = 'user'
      and u.is_filler = false
      and (v_since is null or u.created_at >= v_since)
      and (v_period is null or u.period_label = v_period)
    group by coalesce(u.topic, 'lainnya')
    order by question_count desc, topic asc
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'topic', topic,
    'question_count', question_count,
    'unanswered_count', unanswered_count
  )), '[]'::jsonb)
  into v_topics
  from q_topics;

  with pop as (
    select
      min(u.content) as question,
      max(coalesce(u.topic, 'lainnya')) as topic,
      count(*)::integer as ask_count,
      max(u.created_at) as last_asked_at
    from public.messages u
    where u.school_id = v_school_uuid
      and u.role = 'user'
      and u.is_filler = false
      and (v_since is null or u.created_at >= v_since)
      and (v_period is null or u.period_label = v_period)
    group by lower(regexp_replace(trim(u.content), '\s+', ' ', 'g'))
    order by ask_count desc, last_asked_at desc
    limit 10
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'question', question,
    'topic', topic,
    'count', ask_count,
    'last_asked_at', last_asked_at
  )), '[]'::jsonb)
  into v_popular
  from pop;

  with unans as (
    select
      a.id,
      a.conversation_id,
      coalesce(u.content, '(pertanyaan tidak tercatat)') as question,
      left(a.content, 240) as answer_preview,
      coalesce(u.topic, a.topic, 'lainnya') as topic,
      a.channel,
      a.created_at
    from public.messages a
    left join public.messages u on u.id = a.paired_user_message_id
    where a.school_id = v_school_uuid
      and a.role = 'assistant'
      and a.is_unanswered = true
      and a.is_filler = false
      and (v_since is null or a.created_at >= v_since)
      and (v_period is null or a.period_label = v_period)
    order by a.created_at desc
    limit 25
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id,
    'conversation_id', conversation_id,
    'question', question,
    'answer_preview', answer_preview,
    'topic', topic,
    'channel', channel,
    'created_at', created_at
  )), '[]'::jsonb)
  into v_unanswered
  from unans;

  with hours as (
    select
      gs.hour,
      coalesce(count(m.id), 0)::integer as count
    from generate_series(0, 23) as gs(hour)
    left join public.messages m
      on m.school_id = v_school_uuid
      and m.role = 'user'
      and m.is_filler = false
      and (v_since is null or m.created_at >= v_since)
      and (v_period is null or m.period_label = v_period)
      and extract(hour from (m.created_at at time zone 'Asia/Jakarta'))::integer = gs.hour
    group by gs.hour
    order by gs.hour
  )
  select coalesce(jsonb_agg(jsonb_build_object('hour', hour, 'count', count) order by hour), '[]'::jsonb)
  into v_hours
  from hours;

  with day_names(dow, label, sort_order) as (
    values
      (1, 'Sen', 1),
      (2, 'Sel', 2),
      (3, 'Rab', 3),
      (4, 'Kam', 4),
      (5, 'Jum', 5),
      (6, 'Sab', 6),
      (0, 'Min', 7)
  ),
  days as (
    select
      dn.dow,
      dn.label,
      dn.sort_order,
      coalesce(count(m.id), 0)::integer as count
    from day_names dn
    left join public.messages m
      on m.school_id = v_school_uuid
      and m.role = 'user'
      and m.is_filler = false
      and (v_since is null or m.created_at >= v_since)
      and (v_period is null or m.period_label = v_period)
      and extract(dow from (m.created_at at time zone 'Asia/Jakarta'))::integer = dn.dow
    group by dn.dow, dn.label, dn.sort_order
    order by dn.sort_order
  )
  select coalesce(jsonb_agg(jsonb_build_object('dow', dow, 'label', label, 'count', count) order by sort_order), '[]'::jsonb)
  into v_days
  from days;

  with rec as (
    select
      c.id,
      c.channel,
      c.period_label,
      c.turn_count,
      c.has_unanswered,
      c.call_duration_seconds,
      c.started_at,
      c.last_message_at,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', m.id,
          'role', m.role,
          'channel', m.channel,
          'input_source', m.input_source,
          'content', m.content,
          'topic', m.topic,
          'is_unanswered', m.is_unanswered,
          'had_pii_redacted', m.had_pii_redacted,
          'created_at', m.created_at
        ) order by m.created_at asc)
        from public.messages m
        where m.conversation_id = c.id
          and m.is_filler = false
      ), '[]'::jsonb) as messages
    from public.conversations c
    where c.school_id = v_school_uuid
      and (v_since is null or c.started_at >= v_since)
      and (v_period is null or c.period_label = v_period)
      and c.turn_count > 0
    order by c.last_message_at desc
    limit 15
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id,
    'channel', channel,
    'period_label', period_label,
    'turn_count', turn_count,
    'has_unanswered', has_unanswered,
    'call_duration_seconds', call_duration_seconds,
    'started_at', started_at,
    'last_message_at', last_message_at,
    'messages', messages
  )), '[]'::jsonb)
  into v_recent
  from rec;

  return jsonb_build_object(
    'school', coalesce(v_school, jsonb_build_object('id', null, 'slug', v_school_ref, 'name', v_school_ref, 'active_period_label', '2027-2028')),
    'periods', v_periods,
    'summary', v_summary,
    'topics', v_topics,
    'popular_questions', v_popular,
    'unanswered_questions', v_unanswered,
    'peak_hours', v_hours,
    'peak_days', v_days,
    'recent_conversations', v_recent
  );
end;
$$;

-- 13. Hak eksekusi RPC.
revoke all on function public.is_school_member(uuid) from public, anon;
grant execute on function public.is_school_member(uuid) to authenticated, service_role;

revoke all on function public.create_school_workspace(uuid, text, text) from public, anon;
grant execute on function public.create_school_workspace(uuid, text, text) to authenticated, service_role;

revoke all on function public.increment_school_usage(uuid, uuid) from public, anon, authenticated;
grant execute on function public.increment_school_usage(uuid, uuid) to service_role;

revoke all on function public.resolve_api_key(text) from public, anon, authenticated;
grant execute on function public.resolve_api_key(text) to service_role;

revoke all on function public.record_chat_turn(
  text, text, text, uuid, uuid, text, text, text, boolean, text, boolean, text, boolean, text, text, integer, integer, integer, integer, integer, text, uuid, text
) from public, anon, authenticated;
grant execute on function public.record_chat_turn(
  text, text, text, uuid, uuid, text, text, text, boolean, text, boolean, text, boolean, text, text, integer, integer, integer, integer, integer, text, uuid, text
) to service_role;

revoke all on function public.record_widget_event(
  text, text, text, uuid, uuid, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.record_widget_event(
  text, text, text, uuid, uuid, text, text, jsonb
) to service_role;

revoke all on function public.get_school_analytics(
  text, integer, text
) from public, anon, authenticated;
grant execute on function public.get_school_analytics(
  text, integer, text
) to service_role;
