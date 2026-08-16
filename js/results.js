/* Chip Challenge — the board.
 *
 * Everything here is gated by chip_config.results_unlocked. That isn't a UI
 * courtesy: while the event is locked, RLS refuses to return submissions and
 * answers at all, so a guest who opens devtools still sees nothing.
 */

const HOST_KEY = 'chip-challenge:host';
const PW_KEY = `chip-challenge:${EVENT}:hostpw`;

/* Host mode only decides whether the flip buttons are drawn. The password is
   what actually authorizes the change, and the database checks it. */
const isHost = () => localStorage.getItem(HOST_KEY) === '1'
  || new URLSearchParams(location.search).get('host') === '1';

function hostPassword() {
  let pw = null;
  try { pw = localStorage.getItem(PW_KEY); } catch { /* blocked storage */ }
  if (!pw) pw = prompt('Host password:');
  return pw;
}

let cfg, answers = [], submissions = [], judgeMap = new Map();

/* ------------------------------------------------------------------ load */

async function loadAll() {
  cfg = await loadConfig();
  if (!cfg.results_unlocked) return false;

  const q = `event_slug=eq.${encodeURIComponent(EVENT)}`;
  const [ansRows, subs, judgments] = await Promise.all([
    sb(`/chip_answers?${q}&select=answers`),
    sb(`/chip_submissions?${q}&select=id,player_name,entries,submitted_at,updated_at&order=submitted_at.asc`),
    sb(`/chip_judgments?${q}&select=submission_id,chip_number,correct,note,judged_by`),
  ]);

  answers = (ansRows && ansRows[0] && Array.isArray(ansRows[0].answers)) ? ansRows[0].answers : [];
  submissions = (subs || []).map((s) => ({
    ...s,
    entries: Array.isArray(s.entries) ? s.entries : [],
  }));
  judgeMap = new Map((judgments || []).map((j) => [`${j.submission_id}:${j.chip_number}`, j]));
  return true;
}

/* ------------------------------------------------------------------ verdicts */

const answerFor = (n) => (answers[n - 1] || '').trim();
const entryFor = (sub, n) => sub.entries.find((e) => e.chip === n) || {};

/* null = nothing to judge against yet. Otherwise {correct, by, note}. */
function verdict(sub, n) {
  const stored = judgeMap.get(`${sub.id}:${n}`);
  if (stored) return { correct: !!stored.correct, by: stored.judged_by || 'claude', note: stored.note || '' };
  const answer = answerFor(n);
  if (!answer) return null;
  return { correct: autoMatch(entryFor(sub, n).guess, answer), by: 'auto', note: '' };
}

const scoreOf = (sub) => chipNumbers(cfg.chip_count).filter((n) => (verdict(sub, n) || {}).correct).length;
const hasAnswers = () => answers.some((a) => (a || '').trim());

/* ------------------------------------------------------------------ render */

function render() {
  const n = cfg.chip_count;
  const nums = chipNumbers(n);
  const stats = nums.map((i) => chipStats(submissions, i)).filter((s) => s.votes);

  el('#sub').textContent = submissions.length === 1
    ? '1 brave soul'
    : `${submissions.length} palates, judged`;

  if (!submissions.length) {
    el('#content').innerHTML = `<div class="locked"><span class="lock-emoji">🦗</span>
      <p><strong>Results are open and nobody submitted a thing.</strong></p>
      <p>Somebody go press the button on their sheet.</p></div>`;
    return;
  }

  const byAvg = [...stats].sort((a, b) => b.avg - a.avg);
  const divisive = [...stats].sort((a, b) => b.spread - a.spread)[0];
  const scored = hasAnswers()
    ? [...submissions].map((s) => ({ sub: s, score: scoreOf(s) })).sort((a, b) => b.score - a.score)
    : [];

  el('#content').innerHTML = [
    awardsCard(byAvg, divisive, scored),
    hasAnswers() ? answerKeyCard(nums) : pendingAnswersCard(),
    chipLeaderboard(byAvg),
    scored.length ? guessLeaderboard(scored, n) : '',
    perChip(nums, stats),
    rankMatrix(nums),
  ].join('');

  if (isHost() && hasAnswers()) wireOverrides();
}

function awardsCard(byAvg, divisive, scored) {
  const win = byAvg[0];
  const loser = byAvg.length > 1 ? byAvg[byAvg.length - 1] : null;
  const best = scored[0];
  const worst = scored.length > 2 ? scored[scored.length - 1] : null;

  const row = (a, winner, sub) => `<div class="award">
    <span class="trophy">${a.trophy}</span>
    <span class="award-body">
      <span class="award-name">${a.name}</span>
      <span class="award-win">${winner}</span>
      <span class="award-sub">${sub}</span>
    </span>
  </div>`;

  const named = (n) => answerFor(n) ? `#${n} — ${escapeHtml(answerFor(n))}` : `Chip #${n}`;

  return `<section class="card"><h2>🎖️ The envelope, please</h2>
    ${win ? row(AWARDS.best, named(win.chip), `${AWARDS.best.sub} · ${win.avg}/10`) : ''}
    ${loser ? row(AWARDS.worst, named(loser.chip), `${AWARDS.worst.sub} · ${loser.avg}/10`) : ''}
    ${divisive ? row(AWARDS.divisive, named(divisive.chip), `${AWARDS.divisive.sub} · ±${divisive.spread}`) : ''}
    ${best ? row(AWARDS.guesser, escapeHtml(best.sub.player_name), `${best.score} of ${cfg.chip_count} named correctly`) : ''}
    ${worst && worst.score < best.score ? row(AWARDS.worstGuesser, escapeHtml(worst.sub.player_name), `${worst.score} of ${cfg.chip_count}. ${AWARDS.worstGuesser.sub}`) : ''}
  </section>`;
}

function answerKeyCard(nums) {
  return `<section class="card"><h2>🫣 What you were actually eating</h2>
    ${nums.map((n) => `<div class="answer-line">
      <strong>#${n}</strong> — ${escapeHtml(answerFor(n) || '—')}
    </div>`).join('')}</section>`;
}

function pendingAnswersCard() {
  return `<section class="card"><h2>No answer key yet</h2>
    <p class="hint">Rankings are below. Once the host types in the real flavors,
    this board starts handing out points too.</p></section>`;
}

function chipLeaderboard(byAvg) {
  const top = byAvg[0] ? byAvg[0].avg : 10;
  const medals = ['🥇', '🥈', '🥉'];
  return `<section class="card"><h2>📊 The rankings</h2>
  <div class="scroll-x"><table class="tbl">
    <thead><tr>
      <th></th><th>Chip</th><th class="num">Avg</th>
      <th class="bar-cell"></th><th class="num">Range</th><th class="num">Split</th>
    </tr></thead>
    <tbody>${byAvg.map((s, i) => `<tr>
      <td class="medal">${medals[i] || ''}</td>
      <td><strong>#${s.chip}</strong>${hasAnswers() && answerFor(s.chip) ? `<br><span class="hint">${escapeHtml(answerFor(s.chip))}</span>` : ''}</td>
      <td class="num"><strong>${s.avg}</strong></td>
      <td class="bar-cell"><span class="bar-wrap" style="display:block"><span class="bar" style="width:${Math.max(3, (s.avg / (top || 10)) * 100)}%"></span></span></td>
      <td class="num">${s.worst}–${s.best}</td>
      <td class="num">±${s.spread}</td>
    </tr>`).join('')}</tbody>
  </table></div>
  <p class="hint">Avg = mean rating out of 10. Split = how loudly people disagreed.</p>
  </section>`;
}

function guessLeaderboard(scored, chipCount) {
  const medals = ['🥇', '🥈', '🥉'];
  return `<section class="card"><h2>👅 The Golden Tongue race</h2>
  <div class="scroll-x"><table class="tbl">
    <thead><tr><th></th><th>Taster</th><th class="num">Correct</th><th class="bar-cell"></th></tr></thead>
    <tbody>${scored.map((r, i) => `<tr>
      <td class="medal">${medals[i] || ''}</td>
      <td><strong>${escapeHtml(r.sub.player_name)}</strong></td>
      <td class="num"><strong>${r.score}</strong>/${chipCount}</td>
      <td class="bar-cell"><span class="bar-wrap" style="display:block"><span class="bar" style="width:${Math.max(3, (r.score / chipCount) * 100)}%"></span></span></td>
    </tr>`).join('')}</tbody>
  </table></div></section>`;
}

function perChip(nums, stats) {
  const statOf = (n) => stats.find((s) => s.chip === n) || { avg: '—', votes: 0 };
  return `<section class="card"><h2>🧾 The receipts</h2>
  ${nums.map((n) => {
    const s = statOf(n);
    const answer = answerFor(n);
    return `<details class="chip-detail">
      <summary><span class="chip-badge">${n}</span>
        <span>${answer ? escapeHtml(answer) : `Chip #${n}`}</span>
        <span class="avg">avg ${s.avg}</span>
      </summary>
      <div style="padding:.25rem .2rem .75rem">
        ${submissions.map((sub) => {
          const e = entryFor(sub, n);
          const v = verdict(sub, n);
          const guess = (e.guess || '').trim();
          return `<div class="guess" data-sub="${sub.id}" data-chip="${n}">
            <span class="who">${escapeHtml(sub.player_name)}</span>
            <span class="what${guess ? '' : ' blank'}">${guess ? escapeHtml(guess) : 'chickened out'}</span>
            <span class="meta">
              <span class="hint">rated ${e.rank ?? '—'}/10</span>
              ${v ? `<span class="mark ${v.correct ? 'yes' : 'no'}">${v.correct ? '✓' : '✗'}</span>
                     <span class="tag ${v.by}">${v.by === 'auto' ? 'auto' : v.by === 'host' ? 'host' : 'Claude'}</span>` : ''}
              ${isHost() && v ? `<button class="toggle-correct" type="button">flip</button>` : ''}
            </span>
            ${v && v.note ? `<span class="note hint">${escapeHtml(v.note)}</span>` : ''}
          </div>`;
        }).join('')}
      </div>
    </details>`;
  }).join('')}
  </section>`;
}

function rankMatrix(nums) {
  return `<section class="card"><h2>🔍 Everybody\u2019s numbers</h2>
  <div class="scroll-x"><table class="tbl">
    <thead><tr><th>Taster</th>${nums.map((n) => `<th class="num">#${n}</th>`).join('')}</tr></thead>
    <tbody>${submissions.map((sub) => `<tr>
      <td><strong>${escapeHtml(sub.player_name)}</strong></td>
      ${nums.map((n) => `<td class="num">${entryFor(sub, n).rank ?? '—'}</td>`).join('')}
    </tr>`).join('')}</tbody>
  </table></div></section>`;
}

/* ------------------------------------------------------------------ host overrides */

function wireOverrides() {
  els('.toggle-correct').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const row = btn.closest('.guess');
      const subId = row.dataset.sub;
      const chip = Number(row.dataset.chip);
      const sub = submissions.find((s) => s.id === subId);
      const now = (verdict(sub, chip) || {}).correct;

      const pw = hostPassword();
      if (!pw) return;

      btn.disabled = true;
      try {
        await sb('/rpc/chip_judge', {
          method: 'POST',
          prefer: 'return=minimal',
          body: {
            slug: EVENT,
            submission: subId,
            chip,
            is_correct: !now,
            pw,
            note: 'Host call at the table.',
            judge: 'host',
          },
        });
        try { localStorage.setItem(PW_KEY, pw); } catch { /* ignore */ }
        judgeMap.set(`${subId}:${chip}`, {
          submission_id: subId, chip_number: chip, correct: !now,
          note: 'Host call at the table.', judged_by: 'host',
        });
        const open = els('details.chip-detail').map((d) => d.open);
        render();
        els('details.chip-detail').forEach((d, i) => { d.open = open[i]; });
      } catch (err) {
        /* Wrong password? Forget it so the next tap asks again. */
        if (/host password/i.test(err.message)) {
          try { localStorage.removeItem(PW_KEY); } catch { /* ignore */ }
          alert('Wrong host password.');
        } else {
          alert('Could not save that: ' + err.message);
        }
        btn.disabled = false;
      }
    });
  });
}

/* ------------------------------------------------------------------ waiting */

/* Nobody at a dinner table should have to pull-to-refresh. Poll gently until
   the host opens the board, then draw it in place. */
function waitForOpen() {
  const tick = setInterval(async () => {
    try {
      const fresh = await loadConfig();
      if (fresh.results_unlocked) {
        clearInterval(tick);
        if (await loadAll()) render();
        return;
      }
      /* Host pressed "score & reveal" while this page was sitting on the
         plain locked screen — swap in the waiting message. */
      const scoring = ['requested', 'running'].includes(fresh.judging_state);
      if (scoring && cfg.judging_state !== fresh.judging_state) {
        cfg = fresh;
        el('#sub').textContent = 'Scoring';
        el('#content').innerHTML = `<div class="locked"><span class="lock-emoji">⏳</span>
          <p><strong>Claude is judging you all.</strong></p>
          <p>Politely, and very fast. The board opens by itself — don't refresh.</p></div>`;
      } else {
        cfg = fresh;
      }
    } catch { /* transient — keep waiting */ }
  }, 5000);
}

/* ------------------------------------------------------------------ boot */

(async function init() {
  if (EVENT !== 'default') el('#sheet-link').href = `index.html?event=${encodeURIComponent(EVENT)}`;
  try {
    const open = await loadAll();
    if (!open) {
      const scoring = ['requested', 'running'].includes(cfg.judging_state);
      el('#sub').textContent = scoring ? 'Scoring' : 'Sealed';
      el('#content').innerHTML = scoring
        ? `<div class="locked"><span class="lock-emoji">⏳</span>
            <p><strong>Claude is judging you all.</strong></p>
            <p>Politely, and very fast. The board opens by itself — don't refresh.</p>
          </div>`
        : `<div class="locked"><span class="lock-emoji">🔒</span>
            <p><strong>Sealed until the host says so.</strong></p>
            <p>Nobody likes a peeker. Go eat another chip.</p>
            <p style="margin-top:1.5rem"><a class="btn secondary" href="index.html${EVENT !== 'default' ? '?event=' + encodeURIComponent(EVENT) : ''}">Back to my sheet</a></p>
          </div>`;
      waitForOpen();
      return;
    }
    render();
  } catch (err) {
    el('#sub').textContent = '';
    el('#banner').className = 'banner error';
    el('#banner').textContent = `Couldn't load the results: ${err.message}`;
  }
})();
