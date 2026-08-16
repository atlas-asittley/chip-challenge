#!/usr/bin/env bash
# Chip Challenge — judging watcher.
#
# Polls for events whose host has pressed "Score guesses & reveal", hands the
# guesses to Claude for a ruling on each, writes the verdicts, then unlocks the
# results. Guests never see a half-judged board: the unlock happens last.
#
# Polling is plain psql so idling costs nothing — Claude is only invoked when
# there is actually something to judge.
#
# Fails open. If Claude is unreachable, returns junk, or takes too long, the
# results are unlocked anyway with the automatic text-match verdicts, and the
# admin page reports what happened. A party should never stall on this.

set -uo pipefail

DB_URL_FILE="${DB_URL_FILE:-$HOME/.citybuilder_db_url}"
POLL_SECONDS="${POLL_SECONDS:-10}"
CLAUDE_TIMEOUT="${CLAUDE_TIMEOUT:-180}"
LOG="${LOG:-$HOME/chip-challenge/watcher/watcher.log}"

DB_URL="$(cat "$DB_URL_FILE")"

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG" >&2; }

psql_q() { psql "$DB_URL" -v ON_ERROR_STOP=1 -tAq -c "$1"; }

# Escape a value for safe interpolation into SQL as a literal.
sql_lit() { printf "%s" "$1" | sed "s/'/''/g"; }

# ---------------------------------------------------------------- judging

judge_event() {
  local slug="$1"
  local slug_lit; slug_lit="$(sql_lit "$slug")"

  log "[$slug] judging requested"
  psql_q "update chip_config set judging_state='running' where event_slug='$slug_lit';" >/dev/null

  # Every guess next to the flavor it was supposed to be.
  local payload
  payload="$(psql_q "
    select coalesce(jsonb_agg(x order by x->>'player', (x->>'chip')::int), '[]'::jsonb)::text
    from (
      select jsonb_build_object(
               'submission_id', s.id,
               'player',        s.player_name,
               'chip',          (e->>'chip')::int,
               'guess',         coalesce(e->>'guess',''),
               'answer',        coalesce(a.answers->>((e->>'chip')::int - 1), '')
             ) as x
      from chip_submissions s
      cross join lateral jsonb_array_elements(s.entries) e
      join chip_answers a on a.event_slug = s.event_slug
      where s.event_slug = '$slug_lit'
        and coalesce(a.answers->>((e->>'chip')::int - 1), '') <> ''
    ) t;")"

  if [[ -z "$payload" || "$payload" == "[]" ]]; then
    log "[$slug] nothing to judge"
    finish "$slug" 'done' 'Nothing to judge.'
    return
  fi

  local count; count="$(jq 'length' <<<"$payload")"
  log "[$slug] asking Claude to rule on $count guesses"

  local prompt
  prompt="$(cat <<'PROMPT'
You are judging a blind chip taste test. For each entry below, decide whether the
taster's GUESS is close enough to the real ANSWER to earn the point.

Be a fair, generous party judge, not a pedant:
- Award the point for the right flavor named differently: "bbq" for Barbecue,
  "s&v" or "vinegar" for Salt & Vinegar, "french onion" for Sour Cream & Onion.
- Award it for the dominant flavor even if part of the name is missing:
  "cheddar" for Cheddar & Sour Cream is a point.
- Award it for misspellings: "jalepeno" for Jalapeño.
- Do NOT award it for a category with no flavor in it: "spicy", "cheesy",
  "salty", "chips", "no idea", or an empty guess.
- Do NOT award it for a different flavor that happens to share a word:
  "ranch" is not Sour Cream & Onion.

Reply with ONLY a JSON array, no prose and no code fence. One object per entry,
in the same order:
[{"submission_id":"<uuid>","chip":<int>,"correct":<true|false>,"note":"<max 12 words explaining the call>"}]

The note is read aloud at the table, so make it short and human.

ENTRIES:
PROMPT
)"

  local raw
  raw="$(printf '%s\n%s\n' "$prompt" "$payload" \
    | timeout "$CLAUDE_TIMEOUT" claude -p --output-format text 2>>"$LOG")"
  local rc=$?

  if [[ $rc -ne 0 || -z "$raw" ]]; then
    log "[$slug] claude failed (rc=$rc) — revealing with automatic scoring"
    finish "$slug" 'failed' 'Claude could not be reached. Automatic scoring stands.'
    return
  fi

  # Tolerate a stray code fence or surrounding chatter.
  local verdicts
  verdicts="$(sed -e 's/^```json//' -e 's/^```//' -e 's/```$//' <<<"$raw" \
    | jq -c 'if type=="array" then . else empty end' 2>/dev/null | head -1)"
  if [[ -z "$verdicts" ]]; then
    verdicts="$(grep -o '\[.*\]' <<<"$raw" | jq -c '.' 2>/dev/null | head -1)"
  fi

  if [[ -z "$verdicts" ]]; then
    log "[$slug] could not parse Claude's reply — revealing with automatic scoring"
    finish "$slug" 'failed' 'Claude replied in an unexpected format. Automatic scoring stands.'
    return
  fi

  # Apply in one statement, with the verdicts passed as a bound literal rather
  # than spliced into SQL text. Rows are matched against real submissions, so a
  # hallucinated id is dropped instead of failing the whole pass.
  local applied
  applied="$(psql "$DB_URL" -v ON_ERROR_STOP=1 -tAq \
      -v slug="$slug" -v verdicts="$verdicts" <<'SQL' 2>>"$LOG"
with incoming as (
  select v->>'submission_id' as sid_text,
         (v->>'chip')::int   as chip,
         (v->>'correct')::boolean as correct,
         left(coalesce(v->>'note', ''), 200) as note
  from jsonb_array_elements(:'verdicts'::jsonb) v
  where v->>'submission_id' ~* '^[0-9a-f-]{36}$'
    and (v->>'chip') ~ '^[0-9]+$'
    and v->>'correct' in ('true', 'false')
),
valid as (
  select i.*, s.id as sid
  from incoming i
  join chip_submissions s
    on s.id = i.sid_text::uuid
   and s.event_slug = :'slug'
),
ins as (
  insert into chip_judgments (event_slug, submission_id, chip_number, correct, note, judged_by)
  select :'slug', sid, chip, correct, nullif(note, ''), 'claude' from valid
  on conflict (submission_id, chip_number) do update
    set correct   = excluded.correct,
        note      = excluded.note,
        judged_by = excluded.judged_by,
        judged_at = now()
  returning 1
)
select count(*) from ins;
SQL
  )"

  if [[ -z "$applied" || "$applied" == "0" ]]; then
    log "[$slug] no usable verdicts written — revealing with automatic scoring"
    finish "$slug" 'failed' 'Could not save Claude’s rulings. Automatic scoring stands.'
    return
  fi

  log "[$slug] wrote $applied rulings — unlocking"
  finish "$slug" 'done' "Claude scored $applied guesses."
}

# Unlock the results and record how it went. Always unlocks.
finish() {
  local slug="$1" state="$2" note="$3"
  psql_q "update chip_config
          set results_unlocked = true,
              judging_state = '$(sql_lit "$state")',
              judging_note = '$(sql_lit "$note")'
          where event_slug = '$(sql_lit "$slug")';" >/dev/null
}

# ---------------------------------------------------------------- entry

# One-shot mode, for testing or for re-running a pass by hand:
#   ./judge-watcher.sh --once demo
if [[ "${1:-}" == "--once" ]]; then
  judge_event "${2:?usage: judge-watcher.sh --once <event-slug>}"
  exit 0
fi

log "watcher started (poll ${POLL_SECONDS}s)"

while true; do
  # Anything waiting? Also picks up a 'running' row left behind by a crash or a
  # restart mid-judge, so a reveal never gets stranded.
  pending="$(psql_q "
    select event_slug from chip_config
    where judging_state = 'requested'
       or (judging_state = 'running' and judging_requested_at < now() - interval '10 minutes')
    order by judging_requested_at
    limit 1;" 2>/dev/null)"

  if [[ -n "${pending:-}" ]]; then
    judge_event "$pending"
  fi

  sleep "$POLL_SECONDS"
done
