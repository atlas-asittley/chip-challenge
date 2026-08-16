/* Chip Challenge — host controls.
 *
 * Deliberately unauthenticated: this is a dinner party, and a login would mean
 * a real auth flow for one person. The protection that matters is in the
 * database, not this page — while results are locked, RLS will not return the
 * answer key or anyone's guesses to the public key, so finding this page early
 * gains a snoop nothing except the ability to be annoying.
 */

const HOST_KEY = 'chip-challenge:host';
let cfg;

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
      body: { slug: EVENT, answers },
    });
    flash('Answer key saved');
    banner('ok', 'Answer key saved. Guests still can’t see it until you unlock.');
  } catch (err) {
    banner('error', 'Could not save the answer key: ' + err.message);
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------------ event */

async function saveEvent() {
  const name = el('#event-name-input').value.trim() || 'Chip Challenge';
  let count = parseInt(el('#chip-count-input').value, 10);
  if (!Number.isFinite(count) || count < 1 || count > 30) {
    banner('error', 'Chip count needs to be a number between 1 and 30.');
    return;
  }
  const btn = el('#save-event-btn');
  btn.disabled = true;
  try {
    await sb(`/chip_config?event_slug=eq.${encodeURIComponent(EVENT)}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: { event_name: name, chip_count: count },
    });
    cfg.event_name = name;
    cfg.chip_count = count;
    buildAnswerRows(count, await currentAnswers());
    flash('Event saved');
    banner('ok', `Saved — ${count} chips.`);
  } catch (err) {
    banner('error', 'Could not save: ' + err.message);
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

/* ------------------------------------------------------------------ lock */

async function setLocked(unlocked) {
  const btn = unlocked ? el('#unlock-btn') : el('#lock-btn');
  btn.disabled = true;
  try {
    await sb(`/chip_config?event_slug=eq.${encodeURIComponent(EVENT)}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: { results_unlocked: unlocked },
    });
    cfg.results_unlocked = unlocked;
    paintLock();
    flash(unlocked ? 'Results are live' : 'Results locked');
    banner('ok', unlocked
      ? 'Results are open — send everyone to the Results tab.'
      : 'Results are locked again.');
    if (unlocked) buildAnswerRows(cfg.chip_count, await currentAnswers());
  } catch (err) {
    banner('error', 'Could not change that: ' + err.message);
  } finally {
    btn.disabled = false;
  }
}

function paintLock() {
  el('#lock-state').textContent = cfg.results_unlocked ? 'OPEN' : 'locked';
  el('#unlock-btn').style.display = cfg.results_unlocked ? 'none' : '';
  el('#lock-btn').style.display = cfg.results_unlocked ? '' : 'none';
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

/* ------------------------------------------------------------------ boot */

(async function init() {
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

  el('#event-name-input').value = cfg.event_name || 'Chip Challenge';
  el('#chip-count-input').value = cfg.chip_count || DEFAULT_CHIP_COUNT;
  buildAnswerRows(cfg.chip_count, await currentAnswers());
  paintLock();
  paintHostMode();
  loadRoster();

  if (!cfg.results_unlocked) {
    banner('info', 'Results are locked, so the boxes below start blank even if you already saved a key — the database hides it from this page too. Retyping and saving overwrites it.');
  }

  el('#save-answers-btn').addEventListener('click', saveAnswers);
  el('#save-event-btn').addEventListener('click', saveEvent);
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
})();
