/* Chip Challenge — guess matching + summary maths.
 *
 * Two layers of judging, in priority order:
 *   1. A stored row in chip_judgments  — Claude's ruling, or the host's override.
 *   2. This file's text matcher        — instant, no help needed, sometimes dumb.
 * The results page always says which one it used, so nobody argues with a
 * verdict thinking a human made it.
 */

/* Words that carry no flavor information. */
const NOISE = new Set([
  'chip', 'chips', 'crisp', 'crisps', 'flavor', 'flavour', 'flavored', 'flavoured',
  'style', 'kettle', 'cooked', 'the', 'a', 'an', 'and', 'with', 'of', 'some', 'kind',
  'maybe', 'probably', 'idk', 'guess', 'ish', 'something',
]);

/* Multi-word shorthand. Applied to the whole normalized string, because by the
   time we split on spaces "s&v" has already become "s and v". */
const PHRASES = [
  [/\bs and v\b/g, 'salt and vinegar'],
  [/\bsc and o\b/g, 'sour cream and onion'],
  [/\bs and o\b/g, 'sour cream and onion'],
  [/\bbar b q\b/g, 'barbecue'],
  [/\bsalt n vinegar\b/g, 'salt and vinegar'],
  [/\bsour cream n onion\b/g, 'sour cream and onion'],
];

/* Written-out forms of things people abbreviate or misspell at a dinner table. */
const SYNONYMS = {
  bbq: 'barbecue', barbeque: 'barbecue', bbg: 'barbecue',
  sv: 'salt vinegar', vin: 'vinegar', viniger: 'vinegar',
  vinegary: 'vinegar', salty: 'salt', saltandvinegar: 'salt vinegar',
  sourcream: 'sour cream', scno: 'sour cream onion',
  chedder: 'cheddar', chedar: 'cheddar', cheeze: 'cheese', cheesy: 'cheese',
  jalepeno: 'jalapeno', jalapeño: 'jalapeno', jalapeneo: 'jalapeno',
  ketchupy: 'ketchup', dilly: 'dill', pickled: 'pickle', pickles: 'pickle',
  onions: 'onion', chives: 'chive', ranchy: 'ranch', srirachi: 'sriracha',
  og: 'original', plain: 'original', classic: 'original',
  regular: 'original', spicy: 'hot', buffalo: 'hot wing', jalapenos: 'jalapeno',
};

function normalize(s) {
  let t = String(s ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // jalapeño -> jalapeno
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [re, to] of PHRASES) t = t.replace(re, to);
  return t;
}

/* Bag of meaningful words: noise dropped, synonyms expanded, plurals folded. */
function tokens(s) {
  const out = new Set();
  for (let w of normalize(s).split(' ')) {
    if (!w) continue;
    if (SYNONYMS[w]) { SYNONYMS[w].split(' ').forEach((x) => out.add(x)); continue; }
    if (NOISE.has(w)) continue;
    if (w.length > 3 && w.endsWith('s')) w = w.slice(0, -1);   // onions -> onion
    if (w) out.add(w);
  }
  return out;
}

/* Does `guess` plausibly name `answer`? Deliberately generous: this is a party. */
function autoMatch(guess, answer) {
  if (!guess || !answer) return false;
  if (normalize(guess) === normalize(answer)) return true;

  const g = tokens(guess);
  const a = tokens(answer);
  if (!g.size || !a.size) return false;

  let hits = 0;
  for (const w of a) {
    if (g.has(w)) { hits++; continue; }
    // "cheese" vs "cheesy", "barbecue" vs "barbecued"
    for (const x of g) {
      if ((x.length >= 4 && w.startsWith(x)) || (w.length >= 4 && x.startsWith(w))) { hits++; break; }
    }
  }
  return hits / a.size >= 0.5;
}

/* ------------------------------------------------------------------ stats */

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

const round1 = (x) => Math.round(x * 10) / 10;

/* Ranks a person gave chip n, across every submission. */
function ranksFor(submissions, n) {
  return submissions
    .map((s) => (s.entries.find((e) => e.chip === n) || {}).rank)
    .filter((r) => Number.isFinite(r));
}

function chipStats(submissions, n) {
  const rs = ranksFor(submissions, n);
  return {
    chip: n,
    votes: rs.length,
    avg: round1(mean(rs)),
    best: rs.length ? Math.max(...rs) : 0,
    worst: rs.length ? Math.min(...rs) : 0,
    spread: round1(stdev(rs)),
  };
}
