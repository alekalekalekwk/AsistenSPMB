-- View Q&A berdampingan (pertanyaan user & jawaban AI dalam satu baris) untuk Table Editor Supabase.
create or replace view public.v_chat_qa
with (security_invoker = true) as
select
  a.id as assistant_message_id,
  a.school_id,
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
left join public.messages u on u.id = a.paired_user_message_id
where a.role = 'assistant'
  and a.is_filler = false;

revoke all on public.v_chat_qa from anon, authenticated;
