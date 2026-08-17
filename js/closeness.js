/* Chip Challenge — the closeness board.
 *
 * The main results page asks one question: right or wrong. This one asks a
 * better one — how close did you get? Every guess carries a 1–10 score and a
 * one-line reason, written by Claude after the night, stored in chip_closeness.
 *
 * Read-only. Nothing here writes, and the same unlock gate applies.
 */

let cfg, answers = [], submissions = [], scoreMap = new Map();

/* ------------------------------------------------------------------ load */

async function loadAll() {
  cfg = await loadConfig();
  if (!cfg.results_unlocked) return false;

  const q = `event_slug=eq.${encodeURIComponent(EVENT)}`;
  const [ansRows, subs, scores] = await Promise.all([
    sb(`/chip_answers?${q}&select=answers`),
    sb(`/chip_submissions?${q}&select=id,player_name,entries&order=submitted_at.asc`),
    sb(`/chip_closeness?${q}&select=submission_id,chip_number,score,note`),
  ]);

  answers = (ansRows && ansRows[0] && Array.isArray(ansRows[0].answers)) ? ansRows[0].answers : [];
  submissions = (subs || []).map((s) => ({ ...s, entries: Array.isArray(s.entries) ? s.entries : [] }));
  scoreMap = new Map((scores || []).map((r) => [`${r.submission_id}:${r.chip_number}`, r]));
  return true;
}

const answerFor = (n) => (answers[n - 1] || '').trim();
const entryFor = (sub, n) => sub.entries.find((e) => e.chip === n) || {};
const scoreFor = (sub, n) => scoreMap.get(`${sub.id}:${n}`) || null;

const totalFor = (sub) => chipNumbers(cfg.chip_count)
  .reduce((sum, n) => sum + ((scoreFor(sub, n) || {}).score || 0), 0);

/* Someone can be on the board before their guesses have been scored — a late
   sheet, or a reveal that beat the scoring pass. Ranking them at 0/80 would
   read as "they were terrible" rather than "not judged yet". */
const isScored = (sub) => chipNumbers(cfg.chip_count).some((n) => scoreFor(sub, n));

/* Colour the number by how good it is, so the board is readable at a glance. */
function scoreClass(s) {
  if (s >= 9) return 'perfect';
  if (s >= 7) return 'close';
  if (s >= 4) return 'warm';
  return 'cold';
}

/* ------------------------------------------------------------------ render */

function render() {
  const nums = chipNumbers(cfg.chip_count);
  const max = cfg.chip_count * 10;

  const scoredSubs = submissions.filter(isScored);
  const pending = submissions.filter((s) => !isScored(s));

  const ranked = scoredSubs
    .map((sub) => ({ sub, total: totalFor(sub) }))
    .sort((a, b) => b.total - a.total);

  el('#sub').textContent = `${scoredSubs.length} tasters scored · every guess out of 10`;

  el('#content').innerHTML = [
    leaderboard(ranked, max),
    pendingCard(pending),
    hardestChips(nums),
    ranked.map(({ sub, total }) => person(sub, total, nums, max)).join(''),
    legend(),
  ].join('');
}

function leaderboard(ranked, max) {
  const medals = ['🥇', '🥈', '🥉'];
  const top = ranked[0] ? ranked[0].total : max;
  return `<section class="card"><h2>🎯 Closeness leaderboard</h2>
  <div class="scroll-x"><table class="tbl">
    <thead><tr><th></th><th>Taster</th><th class="num">Points</th><th class="bar-cell"></th><th class="num">Avg</th></tr></thead>
    <tbody>${ranked.map((r, i) => `<tr>
      <td class="medal">${medals[i] || ''}</td>
      <td><strong>${escapeHtml(r.sub.player_name)}</strong></td>
      <td class="num"><strong>${r.total}</strong><span class="hint">/${max}</span></td>
      <td class="bar-cell"><span class="bar-wrap" style="display:block"><span class="bar" style="width:${Math.max(3, (r.total / (top || max)) * 100)}%"></span></span></td>
      <td class="num">${(r.total / cfg.chip_count).toFixed(1)}</td>
    </tr>`).join('')}</tbody>
  </table></div>
  <p class="hint">Every guess scored 1–10 for how close it got to the real flavor,
  instead of a flat right or wrong. ${max} points were on the table.</p>
  </section>`;
}

function pendingCard(pending) {
  if (!pending.length) return '';
  const names = pending.map((s) => escapeHtml(s.player_name)).join(', ');
  return `<section class="card"><h2>⏳ Still to be scored</h2>
    <p><strong>${names}</strong></p>
    <p class="hint">${pending.length > 1 ? 'These sheets are' : 'This sheet is'} in, but the
    guesses haven't been graded yet — so ${pending.length > 1 ? 'they aren\u2019t' : 'it isn\u2019t'}
    on the leaderboard. Nobody scored zero.</p>
  </section>`;
}

/* Which chip fooled the room, and which one gave itself away. */
function hardestChips(nums) {
  const perChip = nums.map((n) => {
    const scores = submissions.map((s) => (scoreFor(s, n) || {}).score).filter(Number.isFinite);
    return {
      chip: n,
      avg: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0,
      count: scores.length,
    };
  }).filter((c) => c.count);

  if (!perChip.length) return '';
  const sorted = [...perChip].sort((a, b) => a.avg - b.avg);
  const hardest = sorted[0];
  const easiest = sorted[sorted.length - 1];

  const line = (c, trophy, label) => `<div class="award">
    <span class="trophy">${trophy}</span>
    <span class="award-body">
      <span class="award-name">${label}</span>
      <span class="award-win">#${c.chip} — ${escapeHtml(answerFor(c.chip) || 'Chip ' + c.chip)}</span>
      <span class="award-sub">Room averaged ${c.avg.toFixed(1)} out of 10</span>
    </span>
  </div>`;

  return `<section class="card"><h2>🕵️ Which chips gave themselves away</h2>
    ${line(easiest, '😋', 'Most obvious')}
    ${line(hardest, '🫥', 'Nobody had a clue')}
  </section>`;
}

function person(sub, total, nums, max) {
  return `<section class="card">
    <h2>${escapeHtml(sub.player_name)} — ${total}/${max}</h2>
    ${nums.map((n) => {
      const e = entryFor(sub, n);
      const s = scoreFor(sub, n);
      const guess = (e.guess || '').trim();
      const val = s ? s.score : null;
      return `<div class="close-row">
        <span class="close-score ${val ? scoreClass(val) : 'cold'}">${val ?? '–'}</span>
        <span class="close-body">
          <span class="close-guess">${guess ? escapeHtml(guess) : '<em>no guess</em>'}</span>
          <span class="close-truth">was <strong>${escapeHtml(answerFor(n) || '—')}</strong></span>
          ${s && s.note ? `<span class="close-note">${escapeHtml(s.note)}</span>` : ''}
        </span>
      </div>`;
    }).join('')}
  </section>`;
}

function legend() {
  return `<section class="card"><h2>How the scoring worked</h2>
    <div class="legend-row"><span class="close-score perfect">9–10</span><span>Named it, or named it in another language. Nothing left to argue about.</span></div>
    <div class="legend-row"><span class="close-score close">7–8</span><span>Same flavor wearing a different hat — shrimp for prawn, Korean barbecue for barbecue.</span></div>
    <div class="legend-row"><span class="close-score warm">4–6</span><span>Right neighborhood. Correct cuisine, correct texture, wrong dish.</span></div>
    <div class="legend-row"><span class="close-score cold">1–3</span><span>Bless you, you were tasting a different chip entirely.</span></div>
    <p class="hint">Scored by Claude after the night, one guess at a time, against the real flavor.</p>
  </section>`;
}

/* ------------------------------------------------------------------ boot */

(async function init() {
  try {
    if (!(await loadAll())) {
      el('#sub').textContent = 'Sealed';
      el('#content').innerHTML = `<div class="locked"><span class="lock-emoji">🔒</span>
        <p><strong>The host hasn't opened the results yet.</strong></p></div>`;
      return;
    }
    if (!scoreMap.size) {
      el('#sub').textContent = '';
      el('#content').innerHTML = `<div class="locked"><span class="lock-emoji">🎯</span>
        <p><strong>No closeness scores for this event yet.</strong></p>
        <p>The plain right-or-wrong results are on the Results tab.</p></div>`;
      return;
    }
    render();
  } catch (err) {
    el('#sub').textContent = '';
    el('#banner').className = 'banner error';
    el('#banner').textContent = `Couldn't load the scores: ${err.message}`;
  }
})();
