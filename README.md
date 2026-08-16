# Chip Challenge

A blind taste-test scorecard. Eight unlabeled chips: guess the flavor, rate it 1–10.
Plain HTML/CSS/JS, no build step. Backed by the shared Supabase project.

Live: **https://atlas-asittley.github.io/chip-challenge/**

| Page | Who it's for |
|---|---|
| `index.html` | Guests — the tasting sheet |
| `results.html` | Everyone — leaderboards, all guesses, rank grid (locked until the host opens it) |
| `admin.html` | Host — answer key, unlock switch, who's turned in a sheet |

## How saving works

Two independent paths, on purpose:

- **localStorage** — every keystroke, on the guest's own device. Closing the tab,
  a dead battery, or an accidental refresh costs nothing. This is *only* on their
  phone; it does not reach the host.
- **Supabase** — on Submit. This is what puts everyone on one board.

The local draft survives submitting, so anyone can reopen the page, change an
answer, and hit submit again. Same name = same sheet, updated in place.

## The lock

`chip_config.results_unlocked` gates everything, and it is enforced in the
database, not in the UI. While it's `false`, RLS refuses to return the answer key
or *anybody's* submissions to the public key — a guest who opens devtools sees
empty arrays. The host flips it from the admin page when the tasting is done.

## Host password

`admin.html` is linked from the guest pages, so it's gated by a password — and
the gate is real, not a UI curtain:

- The password lives in `chip_secrets`, which has RLS on and **no policy at all**.
  The public key cannot read it with any query.
- It is never shipped to the browser. The page collects it and the database
  verifies it (`chip_check_host`).
- Every privileged action re-checks it server-side: `chip_set_lock`,
  `chip_set_answers`, `chip_set_event`, `chip_judge`. `chip_config` has no
  direct write policy, so nobody can flip `results_unlocked` by other means.

Skipping the prompt with devtools therefore gains a guest nothing.

Change it with:

```sql
update chip_secrets set host_password = 'something-else' where event_slug = 'default';
```

## Scoring the guesses

Each guess gets a right/wrong verdict from one of three sources, in priority order:

1. **Host** — the `flip` button on the results page (turn on host mode in admin first).
2. **Claude** — a ruling written into `chip_judgments`, see below.
3. **auto** — `js/scoring.js` text matching: normalizes case/punctuation, expands
   shorthand (`bbq` → barbecue, `s&v` → salt and vinegar), folds plurals, and counts
   a guess correct when it hits ≥50% of the answer's meaningful words.

The results page labels which one decided each call, so nobody argues with the
matcher thinking a person made the ruling.

### Having Claude judge them

The matcher is deliberately dumb. For the close calls, ask a Claude Code session
(phone works — it's paired via remote-control) to judge. The flow:

```bash
# 1. read the guesses next to the real answers
psql "$(cat ~/.citybuilder_db_url)" -c "
  select s.id, s.player_name, e->>'chip' as chip, e->>'guess' as guess,
         a.answers->((e->>'chip')::int - 1) as truth
  from chip_submissions s
  cross join lateral jsonb_array_elements(s.entries) e
  join chip_answers a on a.event_slug = s.event_slug
  where s.event_slug = 'default'
  order by s.player_name, (e->>'chip')::int;"

# 2. write a ruling for each one Claude judges close enough
#    (the host password is pulled from chip_secrets rather than typed here)
psql "$(cat ~/.citybuilder_db_url)" -c "
  select chip_judge('default', '<submission-uuid>'::uuid, 3, true,
                    (select host_password from chip_secrets where event_slug='default'),
                    'Called it vinegar without the salt — close enough.', 'claude');"
```

Rulings show up on the results page immediately with a `CLAUDE` tag and the note.
Anything Claude doesn't rule on keeps its auto verdict.

## Database

Everything is `chip_*` prefixed in the shared project (`igaulapupbtdcqqjobhs`).
Full schema, RLS policies, and functions live in `schema.sql`; apply with:

```bash
psql "$(cat ~/.citybuilder_db_url)" -f schema.sql
```

| Table | Read | Write |
|---|---|---|
| `chip_config` | public | `chip_set_event()`, `chip_set_lock()` — host password |
| `chip_answers` | **only when unlocked** | `chip_set_answers()` — host password |
| `chip_submissions` | **only when unlocked** | `chip_submit()` — open to guests |
| `chip_judgments` | **only when unlocked** | `chip_judge()` — host password |
| `chip_secrets` | **nobody** | SQL only |

Writes go through `SECURITY DEFINER` functions rather than table policies because
an upsert has to read the row it might replace — and while the event is locked,
those rows are deliberately unreadable. `chip_roster()` is the one exception that
peeks past the lock, and it returns names and timestamps only, never a guess.

## Running more than one tasting

Every page takes `?event=<slug>`. Create the event row first:

```sql
insert into chip_config (event_slug, event_name, chip_count)
values ('thanksgiving-2026', 'Thanksgiving Chip Challenge', 10);
```

Then share `…/chip-challenge/?event=thanksgiving-2026`. No slug = the `default` event.

## Automatic scoring on reveal

The host has two reveal buttons. **Reveal now, skip scoring** unlocks immediately.
**Score guesses & reveal** runs a Claude pass first:

1. `chip_request_judging()` sets `judging_state = 'requested'` and leaves the
   results locked. Guests see "Claude is scoring everyone's guesses."
2. `watcher/judge-watcher.sh` — a systemd user service on Drew's machine — polls
   for that state with plain `psql`, so idling costs nothing.
3. It hands every guess and its real answer to `claude -p`, gets back a JSON
   array of verdicts, writes them to `chip_judgments` as `judged_by = 'claude'`.
4. Only then does it set `results_unlocked = true`. Nobody sees a half-judged board.

Typical end-to-end: **under a minute** for 40 guesses.

### It fails open, always

A dinner party must never stall on this. If Claude times out, is missing, replies
with junk, or the write fails, the watcher **unlocks the results anyway** with the
automatic text-match verdicts and records why in `chip_config.judging_note`, which
the admin page displays. If the watcher isn't running at all, the admin page warns
after 3 minutes and the host can press "Stop waiting, reveal now".

### Managing the watcher

```bash
systemctl --user status chip-judge-watcher     # is it up?
systemctl --user restart chip-judge-watcher
journalctl --user -u chip-judge-watcher -f     # live log
tail -f ~/chip-challenge/watcher/watcher.log

./watcher/judge-watcher.sh --once demo         # run one pass by hand
```

The unit file lives at `~/.config/systemd/user/chip-judge-watcher.service`. It is
enabled, and the user has lingering on, so it survives logout and reboot.
