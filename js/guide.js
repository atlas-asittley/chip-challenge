/* Chip Challenge — run of show.
 *
 * A checklist Drew ticks off while hosting, so it has to survive the phone
 * locking, the tab being backgrounded for an hour, and a reload. Same idea as
 * the guest sheet: localStorage, written immediately, per event.
 */

const DONE_KEY = `chip-challenge:${EVENT}:guide`;

function readDone() {
  try {
    const raw = localStorage.getItem(DONE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list : []);
  } catch {
    return new Set();
  }
}

function writeDone(set) {
  try { localStorage.setItem(DONE_KEY, JSON.stringify([...set])); } catch { /* ignore */ }
}

let pillTimer = null;
function flash(text) {
  const pill = el('#saved-pill');
  pill.textContent = text;
  pill.classList.add('show');
  clearTimeout(pillTimer);
  pillTimer = setTimeout(() => pill.classList.remove('show'), 900);
}

function paintProgress() {
  const all = els('li[data-step]');
  const done = all.filter((li) => li.classList.contains('done')).length;
  const pct = all.length ? Math.round((done / all.length) * 100) : 0;
  el('#progress-fill').style.width = pct + '%';
  el('#progress-text').textContent = done === all.length
    ? 'All done. Go eat chips.'
    : `${done} of ${all.length} steps done`;
}

(function init() {
  if (EVENT !== 'default') {
    el('#admin-link').href = `admin.html?event=${encodeURIComponent(EVENT)}`;
  }

  const done = readDone();

  els('li[data-step]').forEach((li) => {
    const id = li.dataset.step;
    if (done.has(id)) li.classList.add('done');

    /* The whole row is the target — this gets tapped one-handed while holding
       a bowl of chips. */
    li.setAttribute('role', 'button');
    li.setAttribute('tabindex', '0');
    li.addEventListener('click', () => toggle(li, id, done));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(li, id, done); }
    });
  });

  el('#reset-btn').addEventListener('click', () => {
    if (!confirm('Clear every checkmark and start over?')) return;
    done.clear();
    writeDone(done);
    els('li[data-step]').forEach((li) => li.classList.remove('done'));
    paintProgress();
  });

  paintProgress();
})();

function toggle(li, id, done) {
  const nowDone = !li.classList.contains('done');
  li.classList.toggle('done', nowDone);
  if (nowDone) done.add(id); else done.delete(id);
  writeDone(done);
  paintProgress();
  flash(nowDone ? 'Checked off' : 'Unchecked');
}
