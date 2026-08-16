/* Chip Challenge — host controls.
 *
 * The password is never in this file. The page collects it, the database
 * verifies it (chip_check_host), and every privileged call carries it so the
 * server re-checks on each action. Skipping this UI with devtools gains a guest
 * nothing: chip_set_lock / chip_set_answers / chip_judge all refuse without it,
 * and chip_config has no direct write policy at all.
 */

const HOST_KEY = 'chip-challenge:host';
const PW_KEY = `chip-challenge:${EVENT}:hostpw`;

let cfg;
let hostPw = null;

const storedPw = () => { try { return localStorage.getItem(PW_KEY); } catch { return null; } };

function banner(kind, msg) {
  const b = el('#banner');
  b.className = 'banner ' + kind;
  b.textContent = msg;
}

let pillTimer = null;
function flash(text) {
  const pill = el('#saved-pill');
  pill.textContent = text;
  pill.classList.add('show');
  clearTimeout(pillTimer);
  pillTimer = setTimeout(() => pill.classList.remove('show'), 1400);
}

/* If the password was changed out from under us, drop back to the gate rather
   than leaving buttons that silently fail. */
function handleError(err, what) {
  if (/host password/i.test(err.message)) {
    forgetPw();
    banner('error', 'That password is no longer accepted. Enter it again.');
    showGate();
    return;
  }
  banner('error', `${what}: ${err.message}`);
}

/* ------------------------------------------------------------------ gate */

function showGate() {
  el('#gate').hidden = false;
  el('#host-only').hidden = true;
  el('#sub').textContent = 'Locked';
  el('#gate-input').focus();
}

function forgetPw() {
  hostPw = null;
  try { localStorage.removeItem(PW_KEY); localStorage.removeItem(HOST_KEY); } catch { /* ignore */ }
}

async function tryPassword(pw) {
  const ok = await sb('/rpc/chip_check_host', { method: 'POST', body: { slug: EVENT, pw } });
  return ok === true;
}

async function enterHost(pw) {
  hostPw = pw;
  try { localStorage.setItem(PW_KEY, pw); } catch { /* private mode: retype each visit */ }
  el('#gate').hidden = true;
  el('#host-only').hidden = false;
  await paintAll();
}

/* ------------------------------------------------------------------ answer key */

function buildAnswerRows(count, values) {
  el('#answer-rows').innerHTML = chipNumbers(count).map((n) => `
    <div class="admin-answer-row">
      <span class="chip-badge">${n}</span>
      <input type="text" id="answer-${n}" maxlength="80"
             placeholder="Real flavor of chip ${n}" value="${escapeHtml(values[n - 1] || '')}">
    </div>`).join('');
}

async function saveAnswers() {
  const answers = chipNumbers(cfg.chip_count).map((n) => el(`#answer-${n}`).value.trim());
  const btn = el('#save-answers-btn');
  btn.disabled = true;
  try {
    await sb('/rpc/chip_set_answers', {
      method: 'POST',
      prefer: 'return=minimal',
      body: { slug: EVENT, answers, pw: hostPw },
    });
    flash('Answer key saved');
    banner('ok', 'Answer key saved. Guests still can’t see it until you unlock.');
  } catch (err) {
    handleError(err, 'Could not save the answer key');
  } finally {
    btn.disabled = false;
  }
}

/* Readable only once unlocked; before that we just show empty boxes. */
async function currentAnswers() {
  try {
    const rows = await sb(`/chip_answers?event_slug=eq.${encodeURIComponent(EVENT)}&select=answers`);
    return (rows && rows[0] && Array.isArray(rows[0].answers)) ? rows[0].answers : [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ event */

async function saveEvent() {
  const name = el('#event-name-input').value.trim() || 'Chip Challenge';
  const count = parseInt(el('#chip-count-input').value, 10);
  if (!Number.isFinite(count) || count < 1 || count > 30) {
    banner('error', 'Chip count needs to be a number between 1 and 30.');
    return;
  }
  const btn = el('#save-event-btn');
  btn.disabled = true;
  try {
    await sb('/rpc/chip_set_event', {
      method: 'POST',
      prefer: 'return=minimal',
      body: { slug: EVENT, name, count, pw: hostPw },
    });
    cfg.event_name = name;
    cfg.chip_count = count;
    buildAnswerRows(count, await currentAnswers());
    flash('Event saved');
    banner('ok', `Saved — ${count} chips.`);
  } catch (err) {
    handleError(err, 'Could not save');
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------------ lock */

async function setLocked(unlocked) {
  const btn = unlocked ? el('#unlock-btn') : el('#lock-btn');
  btn.disabled = true;
  try {
    await sb('/rpc/chip_set_lock', {
      method: 'POST',
      prefer: 'return=minimal',
      body: { slug: EVENT, unlocked, pw: hostPw },
    });
    cfg.results_unlocked = unlocked;
    paintLock();
    flash(unlocked ? 'Results are live' : 'Results locked');
    banner('ok', unlocked
      ? 'Results are open — send everyone to the Results tab.'
      : 'Results are locked again.');
    if (unlocked) buildAnswerRows(cfg.chip_count, await currentAnswers());
  } catch (err) {
    handleError(err, 'Could not change that');
  } finally {
    btn.disabled = false;
  }
}

function paintLock() {
  const scoring = !cfg.results_unlocked
    && (cfg.judging_state === 'requested' || cfg.judging_state === 'running');

  el('#lock-state').textContent = cfg.results_unlocked ? 'OPEN' : scoring ? 'being scored' : 'locked';
  el('#judge-btn').style.display = scoring ? 'none' : '';
  /* Re-scoring an open board is for late sheets — it doesn't hide anything. */
  el('#judge-btn').textContent = cfg.results_unlocked
    ? 'Re-score guesses (for late sheets)'
    : 'Score guesses & reveal';
  el('#judge-btn').className = cfg.results_unlocked ? 'btn ghost' : 'btn';
  el('#unlock-btn').style.display = cfg.results_unlocked ? 'none' : '';
  el('#unlock-btn').textContent = scoring ? 'Stop waiting, reveal now' : 'Reveal now, skip scoring';
  el('#lock-btn').style.display = cfg.results_unlocked ? '' : 'none';

  const status = el('#judge-status');
  if (scoring) {
    status.textContent = 'Claude is scoring the guesses… results open automatically when it finishes.';
  } else if (cfg.results_unlocked && cfg.judging_note) {
    status.textContent = cfg.judging_note;
  } else {
    status.textContent = '';
  }
}

/* While a scoring pass is in flight, follow it so the buttons keep up.
   If nothing is listening at all — machine off, watcher stopped — say so
   rather than leaving guests on a waiting screen indefinitely. */
const JUDGE_PATIENCE_MS = 3 * 60 * 1000;
let judgePoll = null;
function watchJudging() {
  clearInterval(judgePoll);
  const startedAt = Date.now();
  let warned = false;
  judgePoll = setInterval(async () => {
    if (!warned && Date.now() - startedAt > JUDGE_PATIENCE_MS) {
      warned = true;
      banner('error', 'Scoring is taking longer than it should — the judge may be offline. Hit “Stop waiting, reveal now” to open the results with automatic scoring.');
    }
    try {
      const fresh = await loadConfig();
      const changed = fresh.results_unlocked !== cfg.results_unlocked
        || fresh.judging_state !== cfg.judging_state;
      cfg = fresh;
      if (changed) paintLock();
      if (fresh.results_unlocked || !['requested', 'running'].includes(fresh.judging_state)) {
        clearInterval(judgePoll);
        if (fresh.results_unlocked) {
          flash('Results are live');
          banner('ok', (fresh.judging_note ? fresh.judging_note + ' ' : '') + 'Results are open.');
          buildAnswerRows(cfg.chip_count, await currentAnswers());
        }
      }
    } catch { /* transient network — try again next tick */ }
  }, 4000);
}

async function requestJudging() {
  const btn = el('#judge-btn');
  btn.disabled = true;
  try {
    await sb('/rpc/chip_request_judging', {
      method: 'POST',
      prefer: 'return=minimal',
      body: { slug: EVENT, pw: hostPw },
    });
    const wasOpen = cfg.results_unlocked;
    cfg.judging_state = 'requested';
    paintLock();
    banner('info', wasOpen
      ? 'Re-scoring. The board updates itself when Claude is done.'
      : 'Scoring started. This page opens the results by itself when Claude is done.');
    watchJudging();
  } catch (err) {
    handleError(err, 'Could not start scoring');
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------------ roster */

async function loadRoster() {
  const box = el('#roster');
  try {
    const rows = await sb(`/rpc/chip_roster?slug=${encodeURIComponent(EVENT)}`);
    if (!rows || !rows.length) {
      box.innerHTML = '<p class="hint">Nobody yet.</p>';
      el('#sub').textContent = 'No sheets in yet';
      return;
    }
    box.innerHTML = `<table class="tbl"><tbody>${rows.map((r) => `<tr>
        <td><strong>${escapeHtml(r.player_name)}</strong></td>
        <td class="num hint">${new Date(r.updated_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</td>
      </tr>`).join('')}</tbody></table>`;
    el('#sub').textContent = rows.length === 1 ? '1 sheet in' : `${rows.length} sheets in`;
  } catch (err) {
    box.innerHTML = `<p class="hint">Couldn't check: ${escapeHtml(err.message)}</p>`;
  }
}

/* ------------------------------------------------------------------ host mode */

function paintHostMode() {
  const on = localStorage.getItem(HOST_KEY) === '1';
  el('#hostmode-btn').textContent = on ? 'Host mode is ON — turn off' : 'Turn host mode on';
}

/* ------------------------------------------------------------------ paint */

async function paintAll() {
  el('#event-name-input').value = cfg.event_name || 'Chip Challenge';
  el('#chip-count-input').value = cfg.chip_count || DEFAULT_CHIP_COUNT;
  buildAnswerRows(cfg.chip_count, await currentAnswers());
  paintLock();
  paintHostMode();
  loadRoster();

  /* Reopened the page mid-pass? Pick the wait back up. */
  if (!cfg.results_unlocked && ['requested', 'running'].includes(cfg.judging_state)) watchJudging();

  if (!cfg.results_unlocked) {
    banner('info', 'Results are locked, so the answer boxes start blank even if you already saved a key — the database hides it from this page too. Retyping and saving overwrites it.');
  }
}

/* ------------------------------------------------------------------ boot */

(async function init() {
  if (EVENT !== 'default') {
    el('#guide-link').href = `guide.html?event=${encodeURIComponent(EVENT)}`;
  }

  const base = location.href.replace(/admin\.html.*$/, 'index.html');
  el('#share-url').value = EVENT === 'default' ? base : `${base}?event=${encodeURIComponent(EVENT)}`;

  el('#copy-btn').addEventListener('click', async () => {
    const input = el('#share-url');
    try {
      await navigator.clipboard.writeText(input.value);
      flash('Link copied');
    } catch {
      input.select();                       // clipboard API needs https + permission
      flash('Press copy on the highlighted text');
    }
  });

  try {
    cfg = await loadConfig();
  } catch (err) {
    banner('error', 'Could not reach the database: ' + err.message);
    return;
  }

  el('#gate-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = el('#gate-input').value;
    const btn = el('#gate-btn');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
      if (await tryPassword(pw)) {
        banner('', '');
        el('#gate-input').value = '';
        await enterHost(pw);
      } else {
        banner('error', 'Wrong password.');
        el('#gate-input').select();
      }
    } catch (err) {
      banner('error', 'Could not check that: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Unlock host controls';
    }
  });

  el('#save-answers-btn').addEventListener('click', saveAnswers);
  el('#save-event-btn').addEventListener('click', saveEvent);
  el('#judge-btn').addEventListener('click', requestJudging);
  el('#unlock-btn').addEventListener('click', () => setLocked(true));
  el('#lock-btn').addEventListener('click', () => {
    if (confirm('Hide results from everyone again?')) setLocked(false);
  });
  el('#refresh-btn').addEventListener('click', loadRoster);
  el('#hostmode-btn').addEventListener('click', () => {
    const on = localStorage.getItem(HOST_KEY) === '1';
    if (on) localStorage.removeItem(HOST_KEY); else localStorage.setItem(HOST_KEY, '1');
    paintHostMode();
    flash(on ? 'Host mode off' : 'Host mode on');
  });
  el('#signout-btn').addEventListener('click', () => {
    forgetPw();
    banner('info', 'Password forgotten on this device.');
    showGate();
  });

  /* Remembered from last time? Re-verify rather than trusting localStorage. */
  const saved = storedPw();
  if (saved && await tryPassword(saved).catch(() => false)) {
    await enterHost(saved);
  } else {
    if (saved) forgetPw();
    showGate();
  }
})();
