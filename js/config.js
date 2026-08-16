/* Chip Challenge — shared config + tiny Supabase REST helper.
 *
 * No build step, no CDN dependency: we talk to PostgREST with plain fetch.
 * The publishable key below is public by design — it already ships in the
 * frontend of the other apps on the hub, and every chip_* table has RLS.
 */

const SUPABASE_URL = 'https://igaulapupbtdcqqjobhs.supabase.co';
const SUPABASE_KEY = 'sb_publishable_7yi3BNg-J-K5nralw5JSww_c71Pge6e';
const REST = SUPABASE_URL + '/rest/v1';

/* One deployment can host several tastings: ?event=thanksgiving-2026 */
const EVENT = new URLSearchParams(location.search).get('event') || 'default';

const DEFAULT_CHIP_COUNT = 8;
const RANK_MIN = 1;
const RANK_MAX = 10;

/* ------------------------------------------------------------------ REST */

async function sb(path, { method = 'GET', body, prefer } = {}) {
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: 'Bearer ' + SUPABASE_KEY,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (prefer) headers['Prefer'] = prefer;

  const res = await fetch(REST + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).message || ''; } catch { /* non-JSON error body */ }
    throw new Error(`Supabase ${res.status}${detail ? ': ' + detail : ''}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/* Reads the event row. Always readable — it holds nothing secret. */
async function loadConfig() {
  const rows = await sb(`/chip_config?event_slug=eq.${encodeURIComponent(EVENT)}&select=*`);
  return rows && rows[0]
    ? rows[0]
    : { event_slug: EVENT, event_name: 'Chip Challenge', chip_count: DEFAULT_CHIP_COUNT, results_unlocked: false };
}

/* ------------------------------------------------------------------ misc */

const el = (sel, root = document) => root.querySelector(sel);
const els = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function chipNumbers(count) {
  return Array.from({ length: count }, (_, i) => i + 1);
}
