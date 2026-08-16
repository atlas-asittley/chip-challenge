/* Chip Challenge — the jokes.
 *
 * Kept in one file so the tone can be edited without touching any logic, and
 * so nothing here can break a sheet if it's wrong. Aimed at adults after a
 * couple of drinks: suggestive, not explicit. Nobody's mother should have to
 * leave the room.
 */

/* Rotating subtitle under the title. */
const TAGLINES = [
  'Eight bowls. No labels. No dignity.',
  'Trust your tongue. It has never lied to you.',
  'Get your fingers greasy.',
  'No double dipping. We are all watching.',
  'A blind tasting for people with no shame.',
  'Salty, crunchy, anonymous. Just how you like it.',
  'May the best mouth win.',
  'Lick the dust off your fingers. Nobody minds.',
];

/* Shown when a rating is picked. Index 1–10. */
const RATING_QUIPS = [
  '',
  'Genuinely upsetting.',
  "I've licked worse things.",
  'Edible. Technically.',
  'Fine. Just fine.',
  'Perfectly forgettable.',
  'Ooh. Now we’re talking.',
  'Dangerously snackable.',
  'I would fight someone for the last one.',
  'This has ruined me for other chips.',
  'I need a cigarette.',
];

/* Placeholders for the flavor guess. */
const GUESS_PLACEHOLDERS = [
  'Go on, commit…',
  'Something beige?',
  'Say it with your chest…',
  'Your best guess…',
  'Wildly confident answer…',
];

/* After a successful submit. {name} is replaced. */
const SUBMIT_LINES = [
  'Locked in, {name}. Hands off the bowls.',
  'Got it, {name}. Now stop peeking at everyone else.',
  'On the board, {name}. Go wash your hands.',
  'Received, {name}. Your secrets are safe until the reveal.',
  'Down in ink, {name}. No takebacks. (Fine, takebacks — just resubmit.)',
];

/* Named awards on the results page. */
const AWARDS = {
  best:     { trophy: '🏆', name: 'Chip of the Night',     sub: 'Highest average rating' },
  worst:    { trophy: '🗑️', name: 'Bottom of the Bag',     sub: 'Somebody had to be last' },
  divisive: { trophy: '⚔️', name: 'Most Divisive',          sub: 'This one started an argument' },
  guesser:  { trophy: '👑', name: 'The Golden Tongue',      sub: 'Most flavors correctly named' },
  worstGuesser: { trophy: '🤡', name: 'The Numb Palate',    sub: 'Bless them, they tried' },
};

const pick = (list) => list[Math.floor(Math.random() * list.length)];
