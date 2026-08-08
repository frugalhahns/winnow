/* Winnow: capture client.
 *
 * Writes raw notes to `inbox/*.md` in a private GitHub repo via the Contents API.
 * A scheduled Action in that repo sweeps the inbox, categorizes with Gemini,
 * and rewrites `data/notes.json`, which the Browse tab reads back.
 *
 * Auth is either a GitHub App session (tap to sign in, 8h tokens that refresh)
 * or a fine-grained PAT as a fallback. Nothing here renders note text as HTML.
 */

import { CONFIG } from './config.js';

const CFG_KEY = 'winnow.cfg';
const SESSION_KEY = 'winnow.session';
const STATE_KEY = 'winnow.oauth.state';
const QUEUE_KEY = 'winnow.queue';
const API = 'https://api.github.com';

/* Refresh this far before the token actually lapses, so a request in flight
 * does not expire mid-air. */
const REFRESH_MARGIN_MS = 120_000;

const $ = (sel) => document.querySelector(sel);

const el = {
  app: $('#app'),
  form: $('#capture-form'),
  note: $('#note'),
  submit: $('#submit-btn'),
  hint: $('#capture-hint'),
  queue: $('#queue'),
  search: $('#search'),
  refresh: $('#refresh-btn'),
  browseBody: $('#browse-body'),
  sheet: $('#sheet'),
  cfgOwner: $('#cfg-owner'),
  cfgRepo: $('#cfg-repo'),
  cfgToken: $('#cfg-token'),
  cfgErr: $('#cfg-err'),
  cfgSave: $('#cfg-save'),
  cfgForget: $('#cfg-forget'),
  cfgLink: $('#cfg-link'),
  cfgAdvanced: $('#cfg-advanced'),
  settingsBtn: $('#settings-btn'),
  confirm: $('#confirm'),
  confirmBody: $('#confirm-body'),
  confirmYes: $('#confirm-yes'),
  confirmNo: $('#confirm-no'),
  signIn: $('#signin-btn'),
  signInNote: $('#signin-note'),
  toast: $('#toast'),
};

let cfg = loadCfg();
let session = loadSession();
let notesCache = null;

const oauthConfigured = Boolean(CONFIG.clientId && CONFIG.authWorker);

/* Either credential will do. A signed-in session wins when both exist. */
const connected = () => Boolean(session || cfg);
const owner = () => (cfg && cfg.owner) || CONFIG.owner;
const repo = () => (cfg && cfg.repo) || CONFIG.repo;

/* ---------------------------------------------------------------- config */

/* Only the token is stored per-device. Owner and repo come from config.js
 * unless someone has deliberately pointed this build somewhere else. */
function loadCfg() {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (!saved || !saved.token) return null;
    return {
      owner: saved.owner || CONFIG.owner,
      repo: saved.repo || CONFIG.repo,
      token: saved.token,
    };
  } catch {
    return null;
  }
}

function saveCfg(next) {
  cfg = next;
  localStorage.setItem(CFG_KEY, JSON.stringify(next));
}

function clearCfg() {
  cfg = null;
  localStorage.removeItem(CFG_KEY);
}

/* ------------------------------------------------------------- oauth */

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    return s && s.access_token ? s : null;
  } catch {
    return null;
  }
}

function saveSession(data) {
  const now = Date.now();
  session = {
    access_token: data.access_token,
    /* GitHub App tokens last 8 hours. If a value is missing, treat the token as
     * non-expiring rather than refreshing it into oblivion. */
    expires_at: data.expires_in ? now + data.expires_in * 1000 : null,
    refresh_token: data.refresh_token || (session && session.refresh_token) || null,
    refresh_expires_at: data.refresh_token_expires_in
      ? now + data.refresh_token_expires_in * 1000
      : null,
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function clearSession() {
  session = null;
  localStorage.removeItem(SESSION_KEY);
}

function redirectUri() {
  return location.origin + location.pathname;
}

async function postAuth(path, body) {
  let res;
  try {
    res = await fetch(CONFIG.authWorker.replace(/\/+$/, '') + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Could not reach the sign-in service. Check your connection.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.description || data.error || `Sign-in failed (${res.status})`);
  }
  return data;
}

function startSignIn() {
  /* Belt and braces: never send GitHub a blank client_id, whatever the UI did. */
  if (!oauthConfigured) throw new Error('Sign-in is not configured for this build yet.');

  /* Random state, checked on return, so another site cannot feed us a code. */
  const state = crypto.randomUUID();
  sessionStorage.setItem(STATE_KEY, state);

  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', CONFIG.clientId);
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('state', state);
  location.assign(url.toString());
}

/* Returns true if this page load was a return trip from GitHub. */
async function completeSignIn() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const returnedState = params.get('state');
  const denied = params.get('error');

  if (!code && !denied) return false;

  const expected = sessionStorage.getItem(STATE_KEY);
  sessionStorage.removeItem(STATE_KEY);
  history.replaceState(null, '', location.pathname);

  if (denied) throw new Error(params.get('error_description') || 'Sign-in was cancelled.');
  if (!expected || returnedState !== expected) {
    throw new Error('Sign-in could not be verified. Start again from this device.');
  }

  saveSession(await postAuth('/exchange', { code, redirect_uri: redirectUri() }));
  return true;
}

async function refreshSession() {
  if (!session || !session.refresh_token) {
    clearSession();
    throw new Error('Session expired. Sign in again.');
  }
  try {
    saveSession(await postAuth('/refresh', { refresh_token: session.refresh_token }));
  } catch (err) {
    clearSession();
    throw new Error(`Session expired. Sign in again. (${err.message})`);
  }
}

async function bearerToken() {
  if (session) {
    const due = session.expires_at && Date.now() > session.expires_at - REFRESH_MARGIN_MS;
    if (due) await refreshSession();
    return session.access_token;
  }
  if (cfg) return cfg.token;
  throw new Error('Not connected.');
}

/* ------------------------------------------------------------ github api */

async function gh(path, init = {}, retried = false) {
  const token = await bearerToken();
  const res = await fetch(API + path, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers || {}),
    },
  });

  /* Rejected before its stated expiry means revoked or clock skew. Refresh
   * once and retry once, then let the error through. */
  if (res.status === 401 && session && !retried) {
    await refreshSession();
    return gh(path, init, true);
  }

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (body && body.message) detail = body.message;
    } catch {
      /* non-JSON error body; keep statusText */
    }
    const err = new Error(`GitHub ${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

/* base64 of a UTF-8 string, without blowing the call stack on long notes */
function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function fromBase64(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/* ---------------------------------------------------------------- notes */

/* One inbox file per capture, so concurrent writes never collide. */
function inboxPath(when, id) {
  const stamp = when.toISOString().replace(/[:.]/g, '-');
  return `inbox/${stamp}-${id}.md`;
}

function inboxDoc(text, when) {
  return [
    '---',
    `captured: ${when.toISOString()}`,
    `source: web`,
    '---',
    '',
    text.trim(),
    '',
  ].join('\n');
}

async function pushNote(item) {
  const when = new Date(item.at);
  await gh(`/repos/${owner()}/${repo()}/contents/${inboxPath(when, item.id)}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: `capture: ${firstLine(item.text, 60)}`,
      content: toBase64(inboxDoc(item.text, when)),
    }),
  });
}

function firstLine(text, max) {
  const line = text.trim().split('\n')[0].slice(0, max);
  return line || 'note';
}

/* ------------------------------------------------------- offline queue */

function readQueue() {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
  } catch {
    return [];
  }
}

function writeQueue(items) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(items));
  renderQueue(items);
}

function enqueue(text) {
  const items = readQueue();
  items.push({
    id: Math.random().toString(36).slice(2, 8),
    text,
    at: new Date().toISOString(),
  });
  writeQueue(items);
}

/* Drains oldest first. Stops on the first failure so ordering holds and a
 * dead network does not burn through the whole queue against a 401. */
async function flushQueue({ quiet = false } = {}) {
  if (!connected()) return;
  let items = readQueue();
  if (!items.length) return;

  let sent = 0;
  while (items.length) {
    try {
      await pushNote(items[0]);
    } catch (err) {
      if (!quiet) toast(err.message, true);
      break;
    }
    items = items.slice(1);
    writeQueue(items);
    sent += 1;
  }

  if (sent && !quiet) {
    toast(sent === 1 ? 'Saved' : `Saved ${sent} notes`);
  }
}

function renderQueue(items) {
  el.queue.replaceChildren();
  if (!items.length) return;

  for (const item of items) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.className = 'q-text';
    span.textContent = firstLine(item.text, 80);
    const badge = document.createElement('span');
    badge.textContent = 'pending';
    li.append(span, badge);
    el.queue.append(li);
  }
}

/* ---------------------------------------------------------------- browse */

const NOTES_PATH = () => `/repos/${owner()}/${repo()}/contents/data/notes.json`;

/* Returns the sha alongside the data: writing the file back requires it. */
async function fetchNotesFile() {
  const res = await gh(NOTES_PATH());
  const body = await res.json();
  return { data: JSON.parse(fromBase64(body.content)), sha: body.sha };
}

async function fetchNotes() {
  return (await fetchNotesFile()).data;
}

async function loadBrowse({ force = false } = {}) {
  if (notesCache && !force) return renderBrowse(notesCache);

  el.browseBody.replaceChildren(emptyState('Loading', 'Fetching your notes.'));
  try {
    notesCache = await fetchNotes();
    renderBrowse(notesCache);
  } catch (err) {
    if (err.status === 404) {
      /* A 404 is ambiguous: the file may be missing, or this credential may not
       * be able to see the repo at all. GitHub returns 404 rather than 403 for
       * things you are not allowed to know exist. Ask about the repo itself. */
      let reachable = true;
      try {
        await gh(`/repos/${owner()}/${repo()}`);
      } catch {
        reachable = false;
      }

      if (reachable) {
        el.browseBody.replaceChildren(
          emptyState(
            'Nothing winnowed yet',
            'The repo is reachable but data/notes.json is missing. Run the sweep in your notes repo, or wait for the next scheduled one.'
          )
        );
      } else {
        el.browseBody.replaceChildren(
          emptyState(
            `Cannot reach ${owner()}/${repo()}`,
            session
              ? 'Signed in, but this account cannot see that repo. The Winnow GitHub App is most likely not installed on it, or its Contents permission was never granted.'
              : 'This token cannot reach that repo. Check that it grants Contents access to it.',
            session
              ? { label: 'Install the app', href: 'https://github.com/settings/installations' }
              : null
          )
        );
      }
      return;
    }
    el.browseBody.replaceChildren(emptyState('Could not load notes', err.message));
  }
}

function renderBrowse(data) {
  const q = el.search.value.trim().toLowerCase();
  const categories = (data && data.categories) || [];

  const matching = categories
    .map((cat) => ({
      ...cat,
      notes: (cat.notes || []).filter((n) => !q || noteText(n).includes(q)),
    }))
    .filter((cat) => cat.notes.length);

  el.browseBody.replaceChildren();

  if (!matching.length) {
    el.browseBody.append(
      q
        ? emptyState('No matches', `Nothing matches "${el.search.value.trim()}".`)
        : emptyState('Nothing winnowed yet', 'Capture some notes and let the daily sweep sort them.')
    );
    return;
  }

  for (const cat of matching) {
    el.browseBody.append(renderCategory(cat));
  }
}

function noteText(n) {
  return [n.title, n.summary, n.url, (n.tags || []).join(' ')]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function renderCategory(cat) {
  const section = document.createElement('section');
  section.className = 'category';

  const h3 = document.createElement('h3');
  h3.textContent = cat.name;

  const meta = document.createElement('p');
  meta.className = 'cat-meta';
  const count = cat.notes.length;
  meta.textContent = cat.blurb
    ? `${cat.blurb} (${count})`
    : `${count} ${count === 1 ? 'note' : 'notes'}`;

  const list = document.createElement('ul');
  list.className = 'note-list';
  for (const n of cat.notes) list.append(renderNote(n));

  section.append(h3, meta, list);
  return section;
}

function renderNote(n) {
  const row = document.createElement('li');
  row.className = 'note-row';

  const li = document.createElement('article');
  li.className = 'note';

  const title = document.createElement('p');
  title.className = 'n-title';
  if (n.url && isHttpUrl(n.url)) {
    const a = document.createElement('a');
    a.href = n.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = n.title || n.url;
    title.append(a);
  } else {
    title.textContent = n.title || 'Untitled';
  }
  li.append(title);

  if (n.summary) {
    const body = document.createElement('p');
    body.className = 'n-body';
    body.textContent = n.summary;
    li.append(body);
  }

  const foot = document.createElement('div');
  foot.className = 'n-foot';
  for (const t of n.tags || []) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = t;
    foot.append(tag);
  }
  if (n.captured) {
    const when = document.createElement('span');
    when.textContent = formatDate(n.captured);
    foot.append(when);
  }
  if (foot.childElementCount) li.append(foot);

  const del = document.createElement('button');
  del.className = 'note-del';
  del.type = 'button';
  del.textContent = 'Delete';
  del.setAttribute('aria-label', `Delete note: ${n.title || 'Untitled'}`);
  del.addEventListener('click', () => askDelete(n));

  /* Card first so Tab reaches the note's link before the delete button. */
  row.append(li, del);
  attachSwipe(row, li);
  return row;
}

/* ---------------------------------------------------------------- swipe */

const SWIPE = 96;
let openRow = null;

function setRowOpen(row, card, open) {
  if (open && openRow && openRow !== row) closeOpenRow();
  row.dataset.open = open ? '1' : '0';
  card.style.transform = open ? `translateX(-${SWIPE}px)` : '';
  openRow = open ? row : openRow === row ? null : openRow;
}

function closeOpenRow() {
  if (!openRow) return;
  const card = openRow.querySelector('.note');
  openRow.dataset.open = '0';
  if (card) card.style.transform = '';
  openRow = null;
}

function attachSwipe(row, card) {
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let dragging = false;
  let axisLocked = false;

  card.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 1) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      dx = 0;
      dragging = true;
      axisLocked = false;
      card.style.transition = 'none';
    },
    { passive: true }
  );

  card.addEventListener(
    'touchmove',
    (e) => {
      if (!dragging) return;
      const mx = e.touches[0].clientX - startX;
      const my = e.touches[0].clientY - startY;

      /* Decide once whether this gesture is a scroll or a swipe. Guessing per
       * frame makes the list feel like it is fighting the finger. */
      if (!axisLocked) {
        if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
        if (Math.abs(my) >= Math.abs(mx)) {
          dragging = false;
          card.style.transition = '';
          return;
        }
        axisLocked = true;
      }

      const base = row.dataset.open === '1' ? -SWIPE : 0;
      dx = Math.max(-SWIPE, Math.min(0, base + mx));
      card.style.transform = `translateX(${dx}px)`;
      e.preventDefault();
    },
    { passive: false }
  );

  const release = () => {
    if (!dragging) return;
    dragging = false;
    card.style.transition = '';
    if (axisLocked) setRowOpen(row, card, dx <= -SWIPE / 2);
  };

  card.addEventListener('touchend', release);
  card.addEventListener('touchcancel', release);

  /* While the action is showing, a tap should put the card back rather than
   * open the note's link. Capture phase, so it beats the anchor. */
  card.addEventListener(
    'click',
    (e) => {
      if (row.dataset.open === '1') {
        e.preventDefault();
        e.stopPropagation();
        closeOpenRow();
      }
    },
    true
  );
}

/* --------------------------------------------------------------- delete */

let pendingDelete = null;

function askDelete(note) {
  pendingDelete = note;
  el.confirmBody.textContent = note.title || note.summary || note.id;
  el.confirm.hidden = false;
  el.confirmYes.focus();
}

function closeConfirm() {
  pendingDelete = null;
  el.confirm.hidden = true;
  el.confirmYes.disabled = false;
  el.confirmYes.textContent = 'Delete';
}

function withoutNote(data, id) {
  const categories = (data.categories || [])
    .map((c) => ({ ...c, notes: (c.notes || []).filter((n) => n.id !== id) }))
    /* A category with nothing left in it is just noise. */
    .filter((c) => c.notes.length);

  return {
    ...data,
    categories,
    count: categories.reduce((sum, c) => sum + c.notes.length, 0),
  };
}

async function deleteNote(note) {
  /* Re-read immediately before writing. The daily sweep may have rewritten the
   * file since this page loaded, and a stale sha would clobber its work. */
  const { data, sha } = await fetchNotesFile();
  const next = withoutNote(data, note.id);

  await gh(NOTES_PATH(), {
    method: 'PUT',
    body: JSON.stringify({
      message: `delete: ${firstLine(note.title || note.id, 60)}`,
      content: toBase64(JSON.stringify(next, null, 2) + '\n'),
      sha,
    }),
  });

  notesCache = next;
  closeOpenRow();
  renderBrowse(next);
}

/* Only http(s) becomes a link. Blocks javascript: and data: URLs from the model. */
function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function emptyState(headline, detail, action = null) {
  const div = document.createElement('div');
  div.className = 'empty';
  const strong = document.createElement('strong');
  strong.textContent = headline;
  div.append(strong, document.createTextNode(detail));

  if (action) {
    const a = document.createElement('a');
    a.href = action.href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = action.label;
    a.className = 'empty-action';
    div.append(document.createElement('br'), a);
  }
  return div;
}

/* ------------------------------------------------------------------- ui */

let toastTimer;
function toast(message, isError = false) {
  el.toast.textContent = message;
  el.toast.classList.toggle('is-err', isError);
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, isError ? 5200 : 2400);
}

function showView(name) {
  for (const tab of document.querySelectorAll('.tab')) {
    const active = tab.dataset.view === name;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  }
  $('#view-capture').classList.toggle('is-active', name === 'capture');
  $('#view-browse').classList.toggle('is-active', name === 'browse');
  if (name === 'browse') loadBrowse();
}

function openSheet() {
  el.cfgOwner.value = (cfg && cfg.owner) || CONFIG.owner;
  el.cfgRepo.value = (cfg && cfg.repo) || CONFIG.repo;
  el.cfgToken.value = cfg ? cfg.token : '';
  el.cfgForget.hidden = !connected();
  el.cfgLink.hidden = !cfg;
  el.cfgErr.hidden = true;

  el.signIn.hidden = !oauthConfigured || Boolean(session);
  el.signInNote.hidden = el.signIn.hidden;
  /* Without a sign-in button there is nothing above the fold, so open the
   * token section rather than showing an apparently empty dialog. */
  el.cfgAdvanced.open = el.signIn.hidden && !connected();

  el.sheet.hidden = false;
  (el.signIn.hidden ? el.cfgToken : el.signIn).focus();
}

function closeSheet() {
  el.sheet.hidden = true;
}

/* ---------------------------------------------------------------- events */

el.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = el.note.value.trim();
  if (!text) return;

  if (!connected()) {
    openSheet();
    return;
  }

  el.submit.disabled = true;
  enqueue(text);
  el.note.value = '';
  updateHint();

  await flushQueue();
  el.submit.disabled = false;
  el.note.focus();
});

/* Cmd/Ctrl+Enter submits, so capture stays one-handed on a keyboard. */
el.note.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    el.form.requestSubmit();
  }
});

el.note.addEventListener('input', updateHint);

function updateHint() {
  const n = el.note.value.trim().length;
  el.hint.textContent = n ? `${n} character${n === 1 ? '' : 's'}` : '';
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => showView(tab.dataset.view));
}

el.settingsBtn.addEventListener('click', openSheet);

el.sheet.addEventListener('click', (e) => {
  if (e.target === el.sheet && cfg) closeSheet();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!el.confirm.hidden) return closeConfirm();
  if (openRow) return closeOpenRow();
  if (!el.sheet.hidden && cfg) closeSheet();
});

/* Proves the token can actually reach the repo before persisting it, so a typo
 * or an under-scoped token fails here instead of silently on first capture. */
async function connect(next) {
  const prev = cfg;
  cfg = next;
  try {
    await gh(`/repos/${next.owner}/${next.repo}`);
    saveCfg(next);
    return { ok: true };
  } catch (err) {
    cfg = prev;
    return {
      ok: false,
      message:
        err.status === 404
          ? `Cannot reach ${next.owner}/${next.repo}. Check that the token grants Contents access to that repo.`
          : err.message,
    };
  }
}

el.cfgSave.addEventListener('click', async () => {
  const next = {
    owner: el.cfgOwner.value.trim() || CONFIG.owner,
    repo: el.cfgRepo.value.trim() || CONFIG.repo,
    token: el.cfgToken.value.trim(),
  };
  if (!next.token) return showCfgError('Paste a token to connect.');

  el.cfgSave.disabled = true;
  el.cfgSave.textContent = 'Verifying';
  const result = await connect(next);
  el.cfgSave.disabled = false;
  el.cfgSave.textContent = 'Verify & save';

  if (!result.ok) return showCfgError(result.message);

  el.cfgForget.hidden = false;
  el.cfgLink.hidden = false;
  closeSheet();
  toast('Connected');
  flushQueue({ quiet: true });
});

/* Setup link for a second device. The token rides in the fragment, which
 * browsers never send to the server, so it stays out of Pages access logs. */
el.cfgLink.addEventListener('click', async () => {
  if (!cfg) return;
  const link = `${location.origin}${location.pathname}#token=${encodeURIComponent(cfg.token)}`;
  try {
    await navigator.clipboard.writeText(link);
    toast('Setup link copied. It carries the token, so treat it as the token.');
  } catch {
    showCfgError('Clipboard is blocked here. Copy the token field by hand instead.');
  }
});

el.signIn.addEventListener('click', () => {
  const label = el.signIn.textContent;
  el.signIn.disabled = true;
  el.signIn.textContent = 'Redirecting';
  try {
    startSignIn();
  } catch (err) {
    /* Navigation never happened, so put the button back rather than leaving it
     * stuck on "Redirecting" forever. */
    el.signIn.disabled = false;
    el.signIn.textContent = label;
    showCfgError(err.message);
  }
});

el.cfgForget.addEventListener('click', () => {
  const hadSession = Boolean(session);
  clearSession();
  clearCfg();
  el.cfgToken.value = '';
  notesCache = null;
  openSheet();
  toast(
    hadSession
      ? 'Signed out of this device. Revoke access from GitHub to cover them all.'
      : 'Token removed from this device'
  );
});

function showCfgError(message) {
  el.cfgErr.textContent = message;
  el.cfgErr.hidden = false;
}

el.confirmNo.addEventListener('click', closeConfirm);

el.confirm.addEventListener('click', (e) => {
  if (e.target === el.confirm) closeConfirm();
});

el.confirmYes.addEventListener('click', async () => {
  const note = pendingDelete;
  if (!note) return;

  el.confirmYes.disabled = true;
  el.confirmYes.textContent = 'Deleting';
  try {
    await deleteNote(note);
    closeConfirm();
    toast('Deleted');
  } catch (err) {
    closeConfirm();
    toast(err.message, true);
  }
});

el.refresh.addEventListener('click', () => loadBrowse({ force: true }));

let searchTimer;
el.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => notesCache && renderBrowse(notesCache), 120);
});

window.addEventListener('online', () => flushQueue({ quiet: true }));

/* ----------------------------------------------------------------- boot */

/* A one-tap setup link looks like `.../winnow/#token=github_pat_...`.
 * The fragment is stripped before anything else runs so the token never sits
 * in the address bar, in history, or in a Referer header. */
function readSetupToken() {
  if (!location.hash) return null;
  const token = new URLSearchParams(location.hash.slice(1)).get('token');
  if (!token) return null;
  history.replaceState(null, '', location.pathname + location.search);
  return token.trim();
}

async function boot() {
  const handoff = readSetupToken();

  /* Prefill from ?text= / ?url= so an iOS Shortcut or share link can hand off. */
  const params = new URLSearchParams(location.search);
  const shared = [params.get('title'), params.get('text'), params.get('url')]
    .filter(Boolean)
    .join('\n');
  if (shared) {
    el.note.value = shared;
    history.replaceState(null, '', location.pathname);
  }

  renderQueue(readQueue());
  updateHint();
  el.app.hidden = false;

  /* Returning from GitHub takes priority: this load carries a one-use code. */
  let returned = false;
  try {
    returned = await completeSignIn();
    if (returned) toast('Signed in');
  } catch (err) {
    openSheet();
    showCfgError(err.message);
  }

  if (!returned && handoff) {
    const result = await connect({ owner: CONFIG.owner, repo: CONFIG.repo, token: handoff });
    if (result.ok) {
      toast('Connected');
    } else {
      /* Keep the rejected token on screen so a stale or mistyped link is
       * obvious and fixable, rather than silently emptying the field. */
      openSheet();
      el.cfgToken.value = handoff;
      showCfgError(result.message);
    }
  } else if (!connected() && el.sheet.hidden) {
    openSheet();
  }

  if (connected()) flushQueue({ quiet: true });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {
      /* offline shell is a bonus; capture still queues without it */
    });
  }
}

boot();
