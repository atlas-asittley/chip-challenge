/* Chip Challenge — the tasting sheet.
 *
 * Two independent save paths, on purpose:
 *   localStorage : every keystroke, so a closed tab / dead battery costs nothing.
 *   Supabase     : only on Submit, so the host can compare everyone.
 * The local draft is never cleared by a successful submit — if someone reopens
 * the page they see their own answers again and can edit + resubmit.
 */

const DRAFT_KEY = `chip-challenge:${EVENT}:draft`;
const SAVE_DEBOUNCE_MS = 250;

let chipCount = DEFAULT_CHIP_COUNT;
let saveTimer = null;

/* ------------------------------------------------------------------ draft */

function readDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    return d && typeof d === 'object' ? d : null;
  } catch {
    return null;   // corrupt or storage blocked — start fresh rather than break
  }
}

function currentDraft() {
  return {
    name: el('#player-name').value,
    entries: chipNumbers(chipCount).map((n) => ({
      chip: n,
      guess: el(`#guess-${n}`).value.trim(),
      rank: rankOf(n),
    })),
    savedAt: new Date().toISOString(),
  };
}

function saveDraft() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(currentDraft()));
    flashSaved();
  } catch {
    /* private mode / full quota — the form still works, it just won't survive a reload */
  }
}

function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDraft, SAVE_DEBOUNCE_MS);
}

let pillTimer = null;
function flashSaved(text = 'Saved') {
  const pill = el('#saved-pill');
  pill.textContent = text;
  pill.classList.add('show');
  clearTimeout(pillTimer);
  pillTimer = setTimeout(() => pill.classList.remove('show'), 1100);
}

/* ------------------------------------------------------------------ ranks */

function rankOf(n) {
  const pressed = el(`#ranks-${n} button[aria-pressed="true"]`);
  return pressed ? Number(pressed.dataset.rank) : null;
}

function setRank(n, rank) {
  els(`#ranks-${n} button`).forEach((b) => {
    b.setAttribute('aria-pressed', String(Number(b.dataset.rank) === rank));
  });
  const readout = el(`#readout-${n}`);
  readout.textContent = rank ? `${rank}/10` : 'not rated';
  readout.classList.toggle('empty', !rank);

  /* A little heckling as you rate. Purely decorative — never saved. */
  const quip = el(`#quip-${n}`);
  if (quip) {
    quip.textContent = rank ? RATING_QUIPS[rank] : '';
    quip.classList.toggle('show', !!rank);
  }
}

/* ------------------------------------------------------------------ build */

function buildRows(count) {
  el('#chips').insertAdjacentHTML('beforeend', chipNumbers(count).map((n) => `
    <div class="chip-row">
      <div class="chip-head">
        <span class="chip-badge">${n}</span>
        <span class="chip-title">Chip #${n}</span>
      </div>

      <label class="field" for="guess-${n}">What in the world is this?</label>
      <input type="text" id="guess-${n}" maxlength="80" placeholder="${escapeHtml(pick(GUESS_PLACEHOLDERS))}">

      <div class="rank-label">
        <span>How hard did it hit?</span>
        <span class="rank-readout empty" id="readout-${n}">not rated</span>
      </div>
      <div class="ranks" id="ranks-${n}" role="group" aria-label="Rating for chip ${n}">
        ${chipNumbers(RANK_MAX).map((r) => `
          <button type="button" data-chip="${n}" data-rank="${r}" aria-pressed="false">${r}</button>
        `).join('')}
      </div>
      <div class="scale-ends"><span>1 — an insult</span><span>10 — obscene</span></div>
      <span class="quip" id="quip-${n}"></span>
    </div>
  `).join(''));

  /* One delegated listener beats 80 individual ones. */
  el('#chips').addEventListener('click', (e) => {
    const btn = e.target.closest('.ranks button');
    if (!btn) return;
    const n = Number(btn.dataset.chip);
    const r = Number(btn.dataset.rank);
    setRank(n, rankOf(n) === r ? null : r);   // tap the same number again to un-rate
    queueSave();
  });
  el('#chips').addEventListener('input', queueSave);
  el('#player-name').addEventListener('input', queueSave);
}

function restoreDraft() {
  const d = readDraft();
  if (!d) return;
  if (typeof d.name === 'string') el('#player-name').value = d.name;
  (d.entries || []).forEach((e) => {
    const input = el(`#guess-${e.chip}`);
    if (!input) return;                      // chip count shrank since the draft was written
    if (typeof e.guess === 'string') input.value = e.guess;
    if (Number.isInteger(e.rank) && e.rank >= RANK_MIN && e.rank <= RANK_MAX) setRank(e.chip, e.rank);
  });
  banner('info', 'Right where you left off. Nothing lost.');
}

function banner(kind, msg) {
  const b = el('#banner');
  b.className = 'banner ' + kind;
  b.textContent = msg;
}

/* ------------------------------------------------------------------ submit */

async function submit(e) {
  e.preventDefault();
  const btn = el('#submit-btn');
  const draft = currentDraft();
  const name = draft.name.trim();

  if (!name) {
    banner('error', 'Name first. We need someone to blame.');
    el('#player-name').focus();
    return;
  }
  const unrated = draft.entries.filter((x) => !x.rank).map((x) => x.chip);
  if (unrated.length) {
    banner('error', `You skipped ${unrated.length > 1 ? 'chips' : 'chip'} ${unrated.join(', ')}. Rate ${unrated.length > 1 ? 'them' : 'it'} or admit you weren't paying attention.`);
    el(`#ranks-${unrated[0]}`).scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    /* Goes through the chip_submit function, not the table: while results are
       locked the table is unreadable, and an upsert has to read the row it
       might replace. Same name = same sheet, so editing and resubmitting
       updates in place instead of adding a second row. */
    await sb('/rpc/chip_submit', {
      method: 'POST',
      prefer: 'return=minimal',
      body: { slug: EVENT, name, entries: draft.entries },
    });
    saveDraft();
    banner('ok', pick(SUBMIT_LINES).replace('{name}', name));
    btn.textContent = 'Submitted ✓ — resubmit to change an answer';
    flashSaved('On the board');
    celebrate();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    banner('error', `Couldn't send that: ${err.message}. Your answers are still saved on this phone — try again in a sec.`);
    btn.textContent = 'Submit my sheet';
  } finally {
    btn.disabled = false;
  }
}

/* A short burst of snacks. Cleans itself up. */
function celebrate() {
  const bits = ['🥔', '🍟', '🧂', '🎉', '🌶️', '🧀', '🥨'];
  const box = document.createElement('div');
  box.className = 'confetti';
  for (let i = 0; i < 14; i++) {
    const bit = document.createElement('i');
    bit.textContent = bits[Math.floor(Math.random() * bits.length)];
    bit.style.left = Math.random() * 100 + 'vw';
    bit.style.animationDuration = (1.6 + Math.random() * 1.2) + 's';
    bit.style.animationDelay = (Math.random() * 0.4) + 's';
    box.appendChild(bit);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 3600);
}

/* ------------------------------------------------------------------ boot */

(async function init() {
  let cfg;
  try {
    cfg = await loadConfig();
  } catch {
    cfg = { event_name: 'Chip Challenge', chip_count: DEFAULT_CHIP_COUNT };
    banner('error', 'Offline — your sheet still saves on this device, and you can submit once you have signal.');
  }
  chipCount = cfg.chip_count || DEFAULT_CHIP_COUNT;
  el('#event-name').textContent = cfg.event_name || 'Chip Challenge';
  el('#tagline').textContent = pick(TAGLINES);
  document.title = `${cfg.event_name || 'Chip Challenge'} — Blind Taste Test`;

  if (EVENT !== 'default') {
    el('#results-link').href = `results.html?event=${encodeURIComponent(EVENT)}`;
  }

  buildRows(chipCount);
  restoreDraft();
  el('#sheet').addEventListener('submit', submit);

  el('#clear-btn').addEventListener('click', () => {
    if (!confirm('Wipe this whole sheet? Anything you already submitted stays on the board.')) return;
    localStorage.removeItem(DRAFT_KEY);
    location.reload();
  });

  /* Last-ditch save if the page is being torn down mid-debounce. */
  window.addEventListener('pagehide', saveDraft);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveDraft();
  });
})();
