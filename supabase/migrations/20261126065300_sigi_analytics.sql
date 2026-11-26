-- Skema database Supabase untuk analytics & log percakapan Sigi (Asisten SPMB).
-- Jalankan isi file ini sekali di Supabase Dashboard -> SQL Editor.
-- Keamanan: seluruh tabel memakai RLS deny-all untuk anon/authenticated dan hanya diakses
-- lewat backend Sigi (lib/sigi-api.mjs) menggunakan SUPABASE_SERVICE_ROLE_KEY.

create table if not exists public.schools (
  id text primary key,
  name text not null,
  active_period_label text not null default '2027-2028',
  allowed_origins text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists public.conversations (
  id uuid primary key,
  school_id text not null references public.schools(id) on delete cascade,
  visitor_session_id uuid not null,
  channel text not null check (channel in ('chat', 'mic', 'call')),
  period_label text not null,
  turn_count integer not null default 0,
  has_unanswered boolean not null default false,
  call_duration_seconds integer check (call_duration_seconds is null or call_duration_seconds >= 0),
  started_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  ended_at timestamptz
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  school_id text not null references public.schools(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  channel text not null check (channel in ('chat', 'mic', 'call')),
  input_source text not null default 'typed' check (
    input_source in ('typed', 'suggestion_chip', 'mic', 'call_voice', 'system_greeting', 'filler')
  ),
  content text not null,
  had_pii_redacted boolean not null default false,
  is_filler boolean not null default false,
  topic text,
  is_unanswered boolean not null default false,
  tagged_by text not null default 'heuristic' check (tagged_by in ('heuristic', 'llm', 'manual')),
  paired_user_message_id uuid references public.messages(id) on delete set null,
  period_label text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.llm_requests (
  id uuid primary key default gen_random_uuid(),
  school_id text not null references public.schools(id) on delete cascade,
  conversation_id uuid,
  message_id uuid references public.messages(id) on delete set null,
  netra_request_id text,
  channel text not null check (channel in ('chat', 'mic', 'call')),
  model text not null,
  prompt_tokens integer,
  completion_tokens integer,
  total_tokens integer,
  latency_ms integer not null,
  http_status integer not null,
  error_code text,
  created_at timestamptz not null default now()
);

create table if not exists public.widget_events (
  id bigint generated always as identity primary key,
  school_id text not null references public.schools(id) on delete cascade,
  conversation_id uuid,
  visitor_session_id uuid not null,
  event_name text not null check (
    event_name in ('widget_opened', 'suggestion_clicked', 'mic_used', 'call_started', 'call_ended', 'conversation_reset')
  ),
  channel text check (channel is null or channel in ('chat', 'mic', 'call')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Indeks untuk query dashboard analitik per sekolah, periode, dan waktu WIB.
create index if not exists idx_conversations_school_started
  on public.conversations (school_id, started_at desc);

create index if not exists idx_conversations_school_period
  on public.conversations (school_id, period_label, started_at desc);

create index if not exists idx_messages_analytics
  on public.messages (school_id, created_at desc)
  where is_filler = false;

create index if not exists idx_messages_conversation
  on public.messages (conversation_id, created_at asc);

create index if not exists idx_messages_unanswered
  on public.messages (school_id, created_at desc)
  where role = 'assistant' and is_unanswered = true and is_filler = false;

create index if not exists idx_messages_topic
  on public.messages (school_id, topic, created_at desc)
  where role = 'user' and is_filler = false;

create index if not exists idx_llm_requests_school_created
  on public.llm_requests (school_id, created_at desc);

create index if not exists idx_widget_events_school_created
  on public.widget_events (school_id, event_name, created_at desc);

-- Views untuk inspeksi cepat lewat Supabase SQL Editor.
create or replace view public.v_unanswered_questions as
select
  a.id as assistant_message_id,
  a.school_id,
  a.conversation_id,
  a.channel,
  a.period_label,
  coalesce(u.topic, a.topic, 'lainnya') as topic,
  u.content as question,
  a.content as answer,
  a.created_at
from public.messages a
left join public.messages u on u.id = a.paired_user_message_id
where a.role = 'assistant'
  and a.is_unanswered = true
  and a.is_filler = false;

create or replace view public.v_hourly_traffic_wib as
select
  school_id,
  period_label,
  extract(hour from (created_at at time zone 'Asia/Jakarta'))::integer as hour_wib,
  count(*)::integer as question_count
from public.messages
where role = 'user'
  and is_filler = false
group by school_id, period_label, extract(hour from (created_at at time zone 'Asia/Jakarta'));

-- RLS deny-all untuk publik (anon & authenticated). Akses hanya melalui service_role di backend.
alter table public.schools enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.llm_requests enable row level security;
alter table public.widget_events enable row level security;

revoke all on public.schools from anon, authenticated;
revoke all on public.conversations from anon, authenticated;
revoke all on public.messages from anon, authenticated;
revoke all on public.llm_requests from anon, authenticated;
revoke all on public.widget_events from anon, authenticated;
revoke all on public.v_unanswered_questions from anon, authenticated;
revoke all on public.v_hourly_traffic_wib from anon, authenticated;

-- Seed sekolah bawaan dari sekolah/wikrama.js.
insert into public.schools (id, name, active_period_label)
values ('wikrama', 'SMK Wikrama Bogor', '2027-2028')
on conflict (id) do nothing;

-- RPC 1: Mencatat satu giliran percakapan (user + assistant + llm_requests) secara atomik.
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
  p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_school_id text := coalesce(nullif(trim(p_school_id), ''), 'default');
  v_school_name text := coalesce(nullif(trim(p_school_name), ''), v_school_id);
  v_period text := coalesce(nullif(trim(p_period_label), ''), '2027-2028');
  v_channel text := case when p_channel in ('chat', 'mic', 'call') then p_channel else 'chat' end;
  v_source text := case
    when p_input_source in ('typed', 'suggestion_chip', 'mic', 'call_voice', 'system_greeting', 'filler')
      then p_input_source
    else 'typed'
  end;
  v_visitor uuid := coalesce(p_visitor_session_id, gen_random_uuid());
  v_user_msg_id uuid;
  v_assistant_msg_id uuid;
begin
  insert into public.schools (id, name, active_period_label)
  values (v_school_id, v_school_name, v_period)
  on conflict (id) do update
    set name = coalesce(nullif(excluded.name, ''), public.schools.name);

  if p_conversation_id is not null
     and p_user_content is not null
     and p_assistant_content is not null then
    insert into public.conversations (
      id, school_id, visitor_session_id, channel, period_label, turn_count, has_unanswered
    )
    values (
      p_conversation_id, v_school_id, v_visitor, v_channel, v_period, 0, false
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
      p_conversation_id, v_school_id, 'user', v_channel, v_source,
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
      p_conversation_id, v_school_id, 'assistant', v_channel,
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
    school_id, conversation_id, message_id, netra_request_id, channel, model,
    prompt_tokens, completion_tokens, total_tokens, latency_ms, http_status, error_code
  )
  values (
    v_school_id, p_conversation_id, v_assistant_msg_id, p_netra_request_id, v_channel,
    coalesce(nullif(p_model, ''), 'unknown'),
    p_prompt_tokens, p_completion_tokens, p_total_tokens,
    greatest(coalesce(p_latency_ms, 0), 0), coalesce(p_http_status, 0), p_error_code
  );

  return jsonb_build_object(
    'ok', true,
    'user_message_id', v_user_msg_id,
    'assistant_message_id', v_assistant_msg_id
  );
end;
$$;

-- RPC 2: Mencatat event interaksi widget & memperbarui durasi panggilan telepon.
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
  v_school_id text := coalesce(nullif(trim(p_school_id), ''), 'default');
  v_school_name text := coalesce(nullif(trim(p_school_name), ''), v_school_id);
  v_period text := coalesce(nullif(trim(p_period_label), ''), '2027-2028');
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

  insert into public.schools (id, name, active_period_label)
  values (v_school_id, v_school_name, v_period)
  on conflict (id) do nothing;

  insert into public.widget_events (
    school_id, conversation_id, visitor_session_id, event_name, channel, metadata
  )
  values (
    v_school_id, p_conversation_id, v_visitor, p_event_name, v_channel, v_meta
  );

  if p_event_name = 'call_started' and p_conversation_id is not null then
    insert into public.conversations (
      id, school_id, visitor_session_id, channel, period_label, turn_count, has_unanswered
    )
    values (
      p_conversation_id, v_school_id, v_visitor, 'call', v_period, 0, false
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
      and school_id = v_school_id;
  elsif p_event_name = 'conversation_reset' and p_conversation_id is not null then
    update public.conversations
    set ended_at = coalesce(ended_at, now())
    where id = p_conversation_id
      and school_id = v_school_id;
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

-- RPC 3: Mengambil seluruh ringkasan analitik dashboard untuk satu sekolah dalam sekali panggil.
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
  v_school_id text := coalesce(nullif(trim(p_school_id), ''), 'wikrama');
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
  select jsonb_build_object(
    'id', s.id,
    'name', s.name,
    'active_period_label', s.active_period_label
  )
  into v_school
  from public.schools s
  where s.id = v_school_id;

  select coalesce(jsonb_agg(period_label order by period_label desc), '[]'::jsonb)
  into v_periods
  from (
    select distinct period_label
    from public.conversations
    where school_id = v_school_id
  ) p;

  with filtered_conv as (
    select *
    from public.conversations c
    where c.school_id = v_school_id
      and (v_since is null or c.started_at >= v_since)
      and (v_period is null or c.period_label = v_period)
  ),
  filtered_msg as (
    select *
    from public.messages m
    where m.school_id = v_school_id
      and m.is_filler = false
      and (v_since is null or m.created_at >= v_since)
      and (v_period is null or m.period_label = v_period)
  ),
  filtered_llm as (
    select l.*
    from public.llm_requests l
    left join public.conversations c on c.id = l.conversation_id
    where l.school_id = v_school_id
      and (v_since is null or l.created_at >= v_since)
      and (v_period is null or c.period_label is null or c.period_label = v_period)
  ),
  filtered_ev as (
    select *
    from public.widget_events e
    where e.school_id = v_school_id
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
    where u.school_id = v_school_id
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
    where u.school_id = v_school_id
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
    where a.school_id = v_school_id
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
      on m.school_id = v_school_id
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
      on m.school_id = v_school_id
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
    where c.school_id = v_school_id
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
    'school', coalesce(v_school, jsonb_build_object('id', v_school_id, 'name', v_school_id, 'active_period_label', '2027-2028')),
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

revoke all on function public.record_chat_turn(
  text, text, text, uuid, uuid, text, text, text, boolean, text, boolean, text, boolean, text, text, integer, integer, integer, integer, integer, text
) from public, anon, authenticated;
grant execute on function public.record_chat_turn(
  text, text, text, uuid, uuid, text, text, text, boolean, text, boolean, text, boolean, text, text, integer, integer, integer, integer, integer, text
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
