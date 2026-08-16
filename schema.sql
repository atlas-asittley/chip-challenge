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

-- Reveal is two-stage when the host asks for a scoring pass first:
--   idle -> requested -> running -> done   (watcher unlocks at the end)
--   ...  -> failed                          (watcher unlocks anyway, auto verdicts stand)
--   skipped                                 (host revealed without waiting)
alter table chip_config
  add column if not exists judging_state text not null default 'idle';
alter table chip_config
  add column if not exists judging_requested_at timestamptz;
alter table chip_config
  add column if not exists judging_note text;

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

-- ---- chip_config: readable by everyone (the guest page needs the chip count),
-- but writes go through the password-checked functions. A direct UPDATE policy
-- here would let anyone flip results_unlocked and blow the reveal.
drop policy if exists chip_config_select on chip_config;
create policy chip_config_select on chip_config
  for select to anon, authenticated using (true);

drop policy if exists chip_config_insert on chip_config;
drop policy if exists chip_config_update on chip_config;

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

-- ================================================================ host password
-- The host password lives here and nowhere else — in particular, not in any
-- file the browser downloads. RLS is on with NO policy at all, so the public
-- key cannot read this table by any query; only the SECURITY DEFINER functions
-- below can see it. That's what makes the gate real rather than decorative:
-- every privileged action re-checks the password server-side, so skipping the
-- prompt in devtools gains a guest nothing.
create table if not exists chip_secrets (
  event_slug    text primary key references chip_config(event_slug) on delete cascade,
  host_password text not null
);

alter table chip_secrets enable row level security;
revoke all on chip_secrets from anon, authenticated;

create or replace function chip_check_host(slug text, pw text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from chip_secrets s
    where s.event_slug = slug and s.host_password = pw
  );
$$;

-- Raises rather than returns, so every caller below fails closed.
create or replace function chip_require_host(slug text, pw text)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not chip_check_host(slug, pw) then
    raise exception 'Wrong host password';
  end if;
end;
$$;

grant execute on function chip_check_host(text, text) to anon, authenticated;

-- ================================================================ write RPCs
-- All SECURITY DEFINER so they can upsert past the read gate. They are the only
-- write path for these tables, which is why both the validation and the host
-- password check live in here rather than in the browser.

-- Signatures changed when the password argument was added; drop the old ones.
drop function if exists chip_set_answers(text, jsonb);
drop function if exists chip_judge(text, uuid, int, boolean, text, text);

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

-- ---------------------------------------------------------------- host-only
-- Everything below requires the host password.

-- Set the real flavors. Writable while locked, readable only after unlock.
create or replace function chip_set_answers(slug text, answers jsonb, pw text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform chip_require_host(slug, pw);

  if jsonb_typeof(answers) is distinct from 'array' then
    raise exception 'Answers must be a list';
  end if;

  insert into chip_answers (event_slug, answers, updated_at)
  values (slug, answers, now())
  on conflict (event_slug) do update
    set answers = excluded.answers, updated_at = now();
end;
$$;

-- Rename the event or change how many chips are on the sheet.
create or replace function chip_set_event(slug text, name text, count int, pw text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform chip_require_host(slug, pw);

  if count < 1 or count > 30 then
    raise exception 'Chip count must be between 1 and 30';
  end if;

  update chip_config
  set event_name = coalesce(nullif(trim(name), ''), 'Chip Challenge'),
      chip_count = count
  where event_slug = slug;
end;
$$;

-- The reveal. This is the one a guest would most want to press early.
create or replace function chip_set_lock(slug text, unlocked boolean, pw text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform chip_require_host(slug, pw);
  update chip_config
  set results_unlocked = unlocked,
      judging_state = case when unlocked then 'skipped' else 'idle' end,
      judging_note = null
  where event_slug = slug;
end;
$$;

-- Ask for a Claude scoring pass before the reveal. Deliberately does NOT
-- unlock: the watcher does that once the rulings are written, so guests never
-- see a half-judged board. If nothing picks this up, the host can still hit
-- chip_set_lock to reveal immediately with the automatic verdicts.
create or replace function chip_request_judging(slug text, pw text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform chip_require_host(slug, pw);

  if not exists (select 1 from chip_submissions where event_slug = slug) then
    raise exception 'Nobody has submitted a sheet yet';
  end if;
  if not exists (
    select 1 from chip_answers
    where event_slug = slug
      and exists (select 1 from jsonb_array_elements_text(answers) a where trim(a) <> '')
  ) then
    raise exception 'Set the answer key first — there is nothing to judge against';
  end if;

  update chip_config
  set judging_state = 'requested',
      judging_requested_at = now(),
      judging_note = null,
      results_unlocked = false
  where event_slug = slug;
end;
$$;

-- Record a right/wrong ruling on one person's guess for one chip.
create or replace function chip_judge(
  slug text, submission uuid, chip int, is_correct boolean, pw text,
  note text default null, judge text default 'host'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform chip_require_host(slug, pw);

  insert into chip_judgments (event_slug, submission_id, chip_number, correct, note, judged_by, judged_at)
  values (slug, submission, chip, is_correct, note, coalesce(judge, 'host'), now())
  on conflict (submission_id, chip_number) do update
    set correct   = excluded.correct,
        note      = excluded.note,
        judged_by = excluded.judged_by,
        judged_at = now();
end;
$$;

grant execute on function chip_submit(text, text, jsonb)                       to anon, authenticated;
grant execute on function chip_set_answers(text, jsonb, text)                  to anon, authenticated;
grant execute on function chip_set_event(text, text, int, text)                to anon, authenticated;
grant execute on function chip_set_lock(text, boolean, text)                   to anon, authenticated;
grant execute on function chip_request_judging(text, text)                     to anon, authenticated;
grant execute on function chip_judge(text, uuid, int, boolean, text, text, text) to anon, authenticated;

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

-- Host password. Change it here (or with an UPDATE) — never in the frontend.
insert into chip_secrets (event_slug, host_password)
values ('default', 'qwerty')
on conflict (event_slug) do nothing;
