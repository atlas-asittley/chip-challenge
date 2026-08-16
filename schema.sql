-- Chip Challenge — blind chip taste test
-- Tables are chip_* prefixed and live in the shared Supabase project.
-- Applied with psql using the connection string in ~/.citybuilder_db_url.
--
-- Security model (anon key is public, so this matters):
--   chip_config      : world-readable. Holds only harmless stuff (event name, chip count,
--                      whether results are unlocked). Never the answers.
--   chip_answers     : holds the real flavors. SELECT is only permitted once the matching
--                      chip_config row has results_unlocked = true. While the tasting is
--                      running, the answer key is literally unreadable with the anon key.
--   chip_submissions : INSERT always allowed (anyone can submit). SELECT only after unlock,
--                      so nobody can peek at other people's guesses mid-tasting.
--   chip_judgments   : Claude's / the host's per-guess rulings. Same read gate as submissions.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- config (public)
create table if not exists chip_config (
  event_slug        text primary key,
  event_name        text not null default 'Chip Challenge',
  chip_count        int  not null default 8,
  results_unlocked  boolean not null default false,
  created_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------- answer key (gated)
create table if not exists chip_answers (
  event_slug   text primary key references chip_config(event_slug) on delete cascade,
  answers      jsonb not null default '[]'::jsonb,  -- ["Salt & Vinegar", "Dill Pickle", ...]
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------- submissions (gated read)
create table if not exists chip_submissions (
  id            uuid primary key default gen_random_uuid(),
  event_slug    text not null default 'default' references chip_config(event_slug) on delete cascade,
  player_name   text not null,
  -- Normalized name, so "Libby" and " libby " are the same person. Generated (not an
  -- expression index) because PostgREST upsert needs real column names in on_conflict.
  player_key    text generated always as (lower(trim(player_name))) stored,
  entries       jsonb not null,   -- [{"chip":1,"guess":"BBQ","rank":7}, ...]
  submitted_at  timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists chip_submissions_event_idx on chip_submissions (event_slug);

-- One sheet per person per event. Re-submitting updates their row instead of duplicating.
create unique index if not exists chip_submissions_event_player_idx
  on chip_submissions (event_slug, player_key);

-- ---------------------------------------------------------------- judgments (gated read)
create table if not exists chip_judgments (
  id             uuid primary key default gen_random_uuid(),
  event_slug     text not null default 'default' references chip_config(event_slug) on delete cascade,
  submission_id  uuid not null references chip_submissions(id) on delete cascade,
  chip_number    int  not null,
  correct        boolean not null,
  note           text,
  judged_by      text not null default 'claude',
  judged_at      timestamptz not null default now(),
  unique (submission_id, chip_number)
);

create index if not exists chip_judgments_event_idx on chip_judgments (event_slug);

-- ================================================================ RLS
alter table chip_config      enable row level security;
alter table chip_answers     enable row level security;
alter table chip_submissions enable row level security;
alter table chip_judgments   enable row level security;

-- Helper: is this event unlocked?
create or replace function chip_event_unlocked(slug text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select results_unlocked from chip_config where event_slug = slug), false);
$$;

-- ---- chip_config: read freely, host may flip the unlock switch.
drop policy if exists chip_config_select on chip_config;
create policy chip_config_select on chip_config
  for select to anon, authenticated using (true);

drop policy if exists chip_config_insert on chip_config;
create policy chip_config_insert on chip_config
  for insert to anon, authenticated with check (true);

drop policy if exists chip_config_update on chip_config;
create policy chip_config_update on chip_config
  for update to anon, authenticated using (true) with check (true);

-- ---- chip_answers: written via chip_set_answers(), readable ONLY after unlock.
drop policy if exists chip_answers_select on chip_answers;
create policy chip_answers_select on chip_answers
  for select to anon, authenticated using (chip_event_unlocked(event_slug));

drop policy if exists chip_answers_insert on chip_answers;
drop policy if exists chip_answers_update on chip_answers;

-- ---- chip_submissions: writes go through chip_submit() below, never directly.
-- (An upsert can't work here anyway: ON CONFLICT DO UPDATE needs to read the
-- conflicting row, and the select policy hides it while the event is locked.)
drop policy if exists chip_submissions_insert on chip_submissions;
drop policy if exists chip_submissions_update on chip_submissions;

drop policy if exists chip_submissions_select on chip_submissions;
create policy chip_submissions_select on chip_submissions
  for select to anon, authenticated using (chip_event_unlocked(event_slug));

-- ---- chip_judgments: same read gate; written via chip_judge().
drop policy if exists chip_judgments_select on chip_judgments;
create policy chip_judgments_select on chip_judgments
  for select to anon, authenticated using (chip_event_unlocked(event_slug));

drop policy if exists chip_judgments_insert on chip_judgments;
drop policy if exists chip_judgments_update on chip_judgments;

-- ================================================================ write RPCs
-- All three are SECURITY DEFINER so they can upsert past the read gate. They
-- are the only write path for these tables, which is also why the validation
-- lives in here rather than in the browser.

-- Submit or update one person's sheet. Same name = same sheet, so someone who
-- reopens the page and fixes an answer doesn't appear on the board twice.
create or replace function chip_submit(slug text, name text, entries jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  sid uuid;
begin
  if coalesce(trim(name), '') = '' then
    raise exception 'A name is required';
  end if;
  if jsonb_typeof(entries) is distinct from 'array' then
    raise exception 'Entries must be a list';
  end if;
  if jsonb_array_length(entries) > 50 then
    raise exception 'Too many entries';
  end if;
  if not exists (select 1 from chip_config c where c.event_slug = slug) then
    raise exception 'No such event: %', slug;
  end if;

  insert into chip_submissions as s (event_slug, player_name, entries)
  values (slug, left(trim(name), 40), entries)
  on conflict (event_slug, player_key) do update
    set entries     = excluded.entries,
        player_name = excluded.player_name,
        updated_at  = now()
  returning s.id into sid;

  return sid;
end;
$$;

-- Host sets the real flavors. Writable while locked, readable only after unlock.
create or replace function chip_set_answers(slug text, answers jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if jsonb_typeof(answers) is distinct from 'array' then
    raise exception 'Answers must be a list';
  end if;
  if not exists (select 1 from chip_config c where c.event_slug = slug) then
    raise exception 'No such event: %', slug;
  end if;

  insert into chip_answers (event_slug, answers, updated_at)
  values (slug, answers, now())
  on conflict (event_slug) do update
    set answers = excluded.answers, updated_at = now();
end;
$$;

-- Record a right/wrong ruling on one person's guess for one chip.
create or replace function chip_judge(
  slug text, submission uuid, chip int, is_correct boolean,
  note text default null, judge text default 'host'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into chip_judgments (event_slug, submission_id, chip_number, correct, note, judged_by, judged_at)
  values (slug, submission, chip, is_correct, note, coalesce(judge, 'host'), now())
  on conflict (submission_id, chip_number) do update
    set correct = excluded.correct,
        note    = excluded.note,
        judged_by = excluded.judged_by,
        judged_at = now();
end;
$$;

grant execute on function chip_submit(text, text, jsonb)      to anon, authenticated;
grant execute on function chip_set_answers(text, jsonb)        to anon, authenticated;
grant execute on function chip_judge(text, uuid, int, boolean, text, text) to anon, authenticated;

-- ================================================================ roster
-- The host needs to know who has turned a sheet in ("still waiting on Mariah")
-- while results are locked — but RLS correctly hides submissions until unlock.
-- This returns names and timestamps only: never a guess, never a rank.
create or replace function chip_roster(slug text)
returns table (player_name text, updated_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select s.player_name, s.updated_at
  from chip_submissions s
  where s.event_slug = slug
  order by s.updated_at asc;
$$;

grant execute on function chip_roster(text) to anon, authenticated;

-- ================================================================ seed
insert into chip_config (event_slug, event_name, chip_count)
values ('default', 'Chip Challenge', 8)
on conflict (event_slug) do nothing;

insert into chip_answers (event_slug, answers)
values ('default', '[]'::jsonb)
on conflict (event_slug) do nothing;
