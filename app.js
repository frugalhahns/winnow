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

/* Each pending item costs one extra request to read, so cap the listing. */
const PENDING_MAX = 25;

/* Below this you can see everything at once, so a filter control is clutter. */
const TAG_FILTER_FROM = 20;
const SEEN_KEY = 'winnow.seen';

const $ = (sel) => document.querySelector(sel);

const el = {
  app: $('#app'),
  form: $('#capture-form'),
  note: $('#note'),
  submit: $('#submit-btn'),
  hint: $('#capture-hint'),
  dupeWarn: $('#dupe-warn'),
  queue: $('#queue'),
  search: $('#search'),
  refresh: $('#refresh-btn'),
  filterBar: $('#filterbar'),
  motes: $('#motes'),
  swept: $('#swept'),
  selectBtn: $('#select-btn'),
  selectBar: $('#selectbar'),
  selectCount: $('#select-count'),
  mergeBtn: $('#merge-btn'),
  browseBody: $('#browse-body'),
  sheet: $('#sheet'),
  cfgOwner: $('#cfg-owner'),
  cfgRepo: $('#cfg-repo'),
  cfgToken: $('#cfg-token'),
  cfgErr: $('#cfg-err'),
  cfgSave: $('#cfg-save'),
  cfgForget: $('#cfg-forget'),
  cfgClose: $('#cfg-close'),
  cfgLink: $('#cfg-link'),
  cfgAdvanced: $('#cfg-advanced'),
  settingsBtn: $('#settings-btn'),
  confirm: $('#confirm'),
  confirmBody: $('#confirm-body'),
  confirmYes: $('#confirm-yes'),
  confirmTitle: $('#confirm-title'),
  confirmDetail: $('#confirm-detail'),
  confirmNo: $('#confirm-no'),
  signIn: $('#signin-btn'),
  signInNote: $('#signin-note'),
  sheetTitle: $('#sheet-title'),
  introConnected: $('#intro-connected'),
  introSetup: $('#intro-setup'),
  statusText: $('#status-text'),
  statusDetail: $('#status-detail'),
  tokenHelp: $('#token-help'),
  rename: $('#rename'),
  renameTitle: $('#rename-title'),
  renameInput: $('#rename-input'),
  renameOptions: $('#rename-options'),
  renameErr: $('#rename-err'),
  renameSave: $('#rename-save'),
  renameCancel: $('#rename-cancel'),
  toast: $('#toast'),
};

let cfg = loadCfg();
let session = loadSession();
let notesCache = null;
let pendingCache = [];
let urlIndex = null;
let suggestionsCache = null;
/* Notes alone are not enough to consider Browse loaded: pending captures and
 * suggestions come from separate files, and the capture-time prefetch fills
 * notesCache without them. */
let browseLoaded = false;
let activeTag = null;
let freshIds = new Set();
let selectMode = false;
const selected = new Set();

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

  if (sent) {
    /* Browse caches; a fresh capture must not be missing from Pending. */
    notesCache = null;
    browseLoaded = false;
    if (!quiet) toast(sent === 1 ? 'Saved' : `Saved ${sent} notes`);
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

/* --------------------------------------------------- note files */

const filePath = (p) => `/repos/${owner()}/${repo()}/contents/${p.split('/').map(encodeURIComponent).join('/')}`;

/* The index carries no bodies, so the original text is one fetch away in the
 * markdown. Only paid for when someone actually opens it. */
async function fetchNoteFile(note) {
  const res = await gh(filePath(note.path));
  const body = await res.json();
  return { raw: fromBase64(body.content), sha: body.sha };
}

function originalFrom(raw) {
  const match = raw.match(/^##\s+Original\s*$([\s\S]*)/m);
  return (match ? match[1] : raw).trim();
}

/* Mirrors toMarkdown in the sweep's note-files lib. Kept small deliberately:
 * the two must agree, so neither should get clever. */
function yamlScalar(value) {
  const v = String(value ?? '');
  return /^[\w][\w .,'/@+-]*$/.test(v) && !/: /.test(v) ? v : JSON.stringify(v);
}

function toMarkdown(note) {
  const out = [
    '---',
    `id: ${yamlScalar(note.id)}`,
    `title: ${yamlScalar(note.title)}`,
    `category: ${yamlScalar(note.category)}`,
    `tags: [${(note.tags || []).map(yamlScalar).join(', ')}]`,
    `captured: ${yamlScalar(note.captured)}`,
    `source: ${yamlScalar(note.source || 'unknown')}`,
    '---',
    '',
  ];
  if (note.summary) out.push(`> ${note.summary}`, '');
  if ((note.links || []).length) {
    out.push('## Links', '');
    for (const l of note.links) out.push(`- [${(l.label || l.url).replace(/[[\]]/g, '')}](${l.url})`);
    out.push('');
  }
  out.push('## Original', '', `${(note.body || '').trim()}`, '');
  return out.join('\n');
}

/* --------------------------------------------------------------- merge */

const SUGGESTIONS_PATH = () =>
  `/repos/${owner()}/${repo()}/contents/data/suggestions.json`;

/* Combine notes into the oldest of them. Additive: every link, every body and
 * every tag survives. The survivor keeps its title, category and date, so a
 * merge never silently renames or refiles anything. */
function mergeInto(data, ids) {
  const wanted = new Set(ids);
  const found = [];
  for (const cat of data.categories) {
    for (const note of cat.notes) {
      if (wanted.has(note.id)) found.push({ note, category: cat.name });
    }
  }
  if (found.length < 2) throw new Error('Those notes are no longer available to merge.');

  found.sort((a, b) => String(a.note.captured).localeCompare(String(b.note.captured)));
  const primary = found[0].note;
  const others = found.slice(1).map((f) => f.note);

  const links = [...(primary.links || [])];
  const known = new Set(links.map((l) => normalizeUrl(l.url)));
  const tags = new Set(primary.tags || []);
  let body = (primary.body || '').trim();

  for (const other of others) {
    for (const link of other.links || []) {
      const key = normalizeUrl(link.url);
      if (key && !known.has(key)) {
        known.add(key);
        links.push(link);
      }
    }
    for (const tag of other.tags || []) tags.add(tag);

    const addition = (other.body || '').trim();
    if (addition && !body.includes(addition)) {
      body += `\n\n--- merged from "${other.title}", ${String(other.captured).slice(0, 10)} ---\n\n${addition}`;
    }
  }

  const merged = {
    ...primary,
    links,
    body,
    tags: [...tags].slice(0, 6),
    mergedFrom: [...(primary.mergedFrom || []), ...others.map((o) => o.id)],
  };

  const categories = data.categories
    .map((cat) => ({
      ...cat,
      notes: cat.notes
        .filter((n) => !wanted.has(n.id) || n.id === primary.id)
        .map((n) => (n.id === primary.id ? merged : n)),
    }))
    .filter((cat) => cat.notes.length);

  return {
    ...data,
    categories,
    count: categories.reduce((sum, c) => sum + c.notes.length, 0),
  };
}

async function applyMerge(ids) {
  const notes = [];
  for (const cat of notesCache.categories || []) {
    for (const n of cat.notes || []) {
      if (ids.includes(n.id)) notes.push({ ...n, category: cat.name });
    }
  }
  if (notes.length < 2) throw new Error('Those notes are no longer available to merge.');

  notes.sort((a, b) => String(a.captured).localeCompare(String(b.captured)));
  const primary = notes[0];
  const others = notes.slice(1);

  /* Bodies live in the markdown, so fetch what we are about to combine. */
  const files = new Map();
  for (const n of notes) files.set(n.id, await fetchNoteFile(n));

  const links = [...(primary.links || [])];
  const known = new Set(links.map((l) => normalizeUrl(l.url)));
  const tags = new Set(primary.tags || []);
  let body = originalFrom(files.get(primary.id).raw);

  for (const other of others) {
    for (const link of other.links || []) {
      const key = normalizeUrl(link.url);
      if (key && !known.has(key)) {
        known.add(key);
        links.push(link);
      }
    }
    for (const tag of other.tags || []) tags.add(tag);

    const addition = originalFrom(files.get(other.id).raw);
    if (addition && !body.includes(addition)) {
      body += `\n\n--- merged from "${other.title}", ${String(other.captured).slice(0, 10)} ---\n\n${addition}`;
    }
  }

  const merged = {
    ...primary,
    links,
    tags: [...tags].slice(0, 6),
    body,
  };

  /* Write the survivor first: a failure part way through must never leave the
   * absorbed notes deleted and their content nowhere. */
  await gh(filePath(primary.path), {
    method: 'PUT',
    body: JSON.stringify({
      message: `merge: ${ids.length} notes into ${firstLine(primary.title, 40)}`,
      content: toBase64(toMarkdown(merged)),
      sha: files.get(primary.id).sha,
    }),
  });

  for (const other of others) {
    await gh(filePath(other.path), {
      method: 'DELETE',
      body: JSON.stringify({
        message: `merged into ${firstLine(primary.title, 40)}`,
        sha: files.get(other.id).sha,
      }),
    });
  }

  /* Index is derived; the next sweep rebuilds it regardless. */
  let next = notesCache;
  for (const other of others) next = withoutNote(next, other.id);
  next = {
    ...next,
    categories: next.categories.map((cat) => ({
      ...cat,
      notes: cat.notes.map((n) =>
        n.id === primary.id ? { ...n, links, tags: merged.tags } : n
      ),
    })),
  };

  try {
    const current = await fetchNotesFile();
    await gh(NOTES_PATH(), {
      method: 'PUT',
      body: JSON.stringify({
        message: `index: merged ${ids.length} notes`,
        content: toBase64(JSON.stringify(next, null, 2) + '\n'),
        sha: current.sha,
      }),
    });
  } catch {
    /* Screen stays right; the sweep will reconcile the file. */
  }

  notesCache = next;
  urlIndex = buildUrlIndex(next);
  return next;
}

/* Renaming and merging a category are the same operation: move every note into
 * a folder. If the destination already exists, that is a merge. */
async function moveCategory(from, to) {
  const target = String(to).trim();
  if (!target) throw new Error('Give the category a name.');
  if (target === from) return notesCache;

  const cat = (notesCache.categories || []).find((c) => c.name === from);
  if (!cat) throw new Error(`${from} is no longer there.`);

  const folder = target.replace(/[\/\\:]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Unsorted';

  for (const note of cat.notes) {
    const { raw, sha } = await fetchNoteFile(note);
    const moved = withCategory(raw, target);
    const dest = `notes/${folder}/${note.path.split('/').pop()}`;

    /* Write the new file before removing the old one, so an interruption
     * leaves a duplicate rather than a hole. */
    await gh(filePath(dest), {
      method: 'PUT',
      body: JSON.stringify({ message: `move: ${firstLine(note.title, 40)} to ${target}`, content: toBase64(moved) }),
    });
    await gh(filePath(note.path), {
      method: 'DELETE',
      body: JSON.stringify({ message: `moved to ${target}`, sha }),
    });
    note.path = dest;
  }

  /* Fold into the destination if it already exists, otherwise just rename. */
  const rest = notesCache.categories.filter((c) => c.name !== from);
  const existing = rest.find((c) => c.name === target);
  if (existing) existing.notes = [...existing.notes, ...cat.notes];
  else rest.push({ ...cat, name: target });

  const categories = rest
    .filter((c) => c.notes.length)
    .sort((a, b) => b.notes.length - a.notes.length || a.name.localeCompare(b.name));

  const next = { ...notesCache, categories, count: categories.reduce((n, c) => n + c.notes.length, 0) };

  try {
    const current = await fetchNotesFile();
    await gh(NOTES_PATH(), {
      method: 'PUT',
      body: JSON.stringify({
        message: `index: ${existing ? 'merge' : 'rename'} category ${from} into ${target}`,
        content: toBase64(JSON.stringify(next, null, 2) + '\n'),
        sha: current.sha,
      }),
    });
  } catch {
    /* Derived; the next sweep reconciles it. */
  }

  notesCache = next;
  urlIndex = buildUrlIndex(next);
  return next;
}

/* Rewrites just the category line, so hand edits elsewhere in the file survive. */
function withCategory(raw, category) {
  const match = raw.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!match) return raw;
  const front = match[2]
    .split(/\r?\n/)
    .map((line) => (/^category:/.test(line) ? `category: ${yamlScalar(category)}` : line))
    .join('\n');
  return raw.replace(match[0], `${match[1]}${front}${match[3]}`);
}

async function fetchSuggestions() {
  try {
    const res = await gh(SUGGESTIONS_PATH());
    const body = await res.json();
    return { data: JSON.parse(fromBase64(body.content)), sha: body.sha };
  } catch (err) {
    /* No weekly run yet. Not a problem worth mentioning. */
    if (err.status === 404) return { data: { groups: [], dismissed: [] }, sha: null };
    throw err;
  }
}

/* Removing a group is the same write whether it was merged or dismissed: the
 * difference is only whether the key is remembered as unwanted. */
async function resolveSuggestion(key, { remember }) {
  const { data, sha } = await fetchSuggestions();
  if (!sha) return;

  const next = {
    ...data,
    groups: (data.groups || []).filter((g) => g.key !== key),
    categoryGroups: (data.categoryGroups || []).filter((g) => g.key !== key),
    dismissed: remember
      ? [...new Set([...(data.dismissed || []), key])]
      : data.dismissed || [],
  };

  await gh(SUGGESTIONS_PATH(), {
    method: 'PUT',
    body: JSON.stringify({
      message: remember ? 'dismiss suggestion' : 'apply suggestion',
      content: toBase64(JSON.stringify(next, null, 2) + '\n'),
      sha,
    }),
  });
  suggestionsCache = next;
}

function renderCategorySuggestions(groups) {
  const section = document.createElement('section');
  section.className = 'category is-suggested';

  const h3 = document.createElement('h3');
  h3.textContent = 'Might be one category';

  const meta = document.createElement('p');
  meta.className = 'cat-meta';
  meta.textContent = 'Merging moves every note inside them. Nothing happens until you say so.';
  section.append(h3, meta);

  for (const group of groups) {
    const card = document.createElement('div');
    card.className = 'suggestion';

    const reason = document.createElement('p');
    reason.className = 'sug-reason';
    reason.textContent = group.reason || 'These look like the same shelf.';

    const list = document.createElement('ul');
    list.className = 'sug-titles';
    for (const name of group.categories) {
      const li = document.createElement('li');
      li.textContent = name === group.into ? `${name} (kept)` : name;
      list.append(li);
    }

    const actions = document.createElement('div');
    actions.className = 'sug-actions';

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'ghost';
    dismiss.textContent = 'Keep separate';
    dismiss.addEventListener('click', async () => {
      dismiss.disabled = true;
      try {
        await resolveSuggestion(group.key, { remember: true });
        renderBrowse(notesCache);
      } catch (err) {
        dismiss.disabled = false;
        toast(err.message, true);
      }
    });

    const merge = document.createElement('button');
    merge.type = 'button';
    merge.className = 'primary';
    merge.textContent = `Merge into ${group.into}`;
    merge.addEventListener('click', () =>
      askDelete(group.categories.join('  +  '), async () => {
        for (const name of group.categories) {
          if (name !== group.into) await moveCategory(name, group.into);
        }
        await resolveSuggestion(group.key, { remember: false });
        renderBrowse(notesCache);
      }, {
        title: 'Merge these categories?',
        detail: `Every note moves into "${group.into}". The notes themselves are untouched, and you can rename or split them again at any time.`,
        confirmLabel: 'Merge',
        danger: false,
      })
    );

    actions.append(dismiss, merge);
    card.append(reason, list, actions);
    section.append(card);
  }
  return section;
}

function renderSuggestions(groups) {
  const section = document.createElement('section');
  section.className = 'category is-suggested';

  const h3 = document.createElement('h3');
  h3.textContent = 'Might be one note';

  const meta = document.createElement('p');
  meta.className = 'cat-meta';
  meta.textContent = 'Suggestions only. Nothing changes until you say so.';

  section.append(h3, meta);

  for (const group of groups) {
    const card = document.createElement('div');
    card.className = 'suggestion';

    const reason = document.createElement('p');
    reason.className = 'sug-reason';
    reason.textContent = group.reason || 'These look like the same thing.';
    card.append(reason);

    const list = document.createElement('ul');
    list.className = 'sug-titles';
    for (const title of group.titles || []) {
      const li = document.createElement('li');
      li.textContent = title;
      list.append(li);
    }
    card.append(list);

    const actions = document.createElement('div');
    actions.className = 'sug-actions';

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'ghost';
    dismiss.textContent = 'Keep separate';
    dismiss.addEventListener('click', async () => {
      dismiss.disabled = true;
      try {
        await resolveSuggestion(group.key, { remember: true });
        renderBrowse(notesCache);
        toast('Kept separate. You will not be asked again.');
      } catch (err) {
        dismiss.disabled = false;
        toast(err.message, true);
      }
    });

    const merge = document.createElement('button');
    merge.type = 'button';
    merge.className = 'primary';
    merge.textContent = 'Merge';
    merge.addEventListener('click', () =>
      askDelete(
        (group.titles || []).join('  +  '),
        async () => {
          await applyMerge(group.noteIds);
          await resolveSuggestion(group.key, { remember: false });
          renderBrowse(notesCache);
        },
        MERGE_COPY
      )
    );

    actions.append(dismiss, merge);
    card.append(actions);
    section.append(card);
  }

  return section;
}

/* ------------------------------------------------------- pending inbox */

/* Captures that have reached the repo but not yet been sorted. Without this
 * a note is invisible between writing it and the next sweep. */
async function fetchPending() {
  let listing;
  try {
    const res = await gh(`/repos/${owner()}/${repo()}/contents/inbox`);
    listing = await res.json();
  } catch (err) {
    /* No inbox directory yet is not an error worth showing. */
    if (err.status === 404) return [];
    throw err;
  }
  if (!Array.isArray(listing)) return [];

  const files = listing
    .filter((f) => f.type === 'file' && f.name.endsWith('.md'))
    .sort((a, b) => b.name.localeCompare(a.name))
    .slice(0, PENDING_MAX);

  /* The directory listing carries no content, so each file needs its own read. */
  return Promise.all(
    files.map(async (f) => {
      const res = await gh(`/repos/${owner()}/${repo()}/contents/${f.path}`);
      const body = await res.json();
      const raw = fromBase64(body.content);
      const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
      const text = (match ? match[2] : raw).trim();
      const captured = match && (match[1].match(/captured:\s*(\S+)/) || [])[1];
      return { path: f.path, sha: body.sha, text, captured: captured || null };
    })
  );
}

async function deletePending(item) {
  await gh(`/repos/${owner()}/${repo()}/contents/${item.path}`, {
    method: 'DELETE',
    body: JSON.stringify({
      message: `discard: ${firstLine(item.text, 60)}`,
      sha: item.sha,
    }),
  });
  pendingCache = pendingCache.filter((p) => p.path !== item.path);
  renderBrowse(notesCache);
}

function renderPending(items) {
  const section = document.createElement('section');
  section.className = 'category is-pending';

  const h3 = document.createElement('h3');
  h3.textContent = 'Pending';

  const meta = document.createElement('p');
  meta.className = 'cat-meta';
  meta.textContent = `${items.length} waiting for the next sweep, daily at 11:00 UTC`;

  const list = document.createElement('ul');
  list.className = 'note-list';

  for (const item of items) {
    const row = document.createElement('li');
    row.className = 'note-row';

    const card = document.createElement('article');
    card.className = 'note';

    const body = document.createElement('p');
    body.className = 'n-body';
    body.textContent = item.text;
    card.append(body);

    if (item.captured) {
      const foot = document.createElement('div');
      foot.className = 'n-foot';
      const when = document.createElement('span');
      when.textContent = formatDate(item.captured);
      foot.append(when);
      card.append(foot);
    }

    const del = document.createElement('button');
    del.className = 'note-del';
    del.type = 'button';
    del.textContent = 'Discard';
    del.setAttribute('aria-label', `Discard pending note: ${firstLine(item.text, 40)}`);
    del.addEventListener('click', () =>
      askDelete(firstLine(item.text, 80), () => deletePending(item))
    );

    row.append(card, del);
    attachSwipe(row, card);
    list.append(row);
  }

  section.append(h3, meta, list);
  return section;
}

async function loadBrowse({ force = false } = {}) {
  if (browseLoaded && !force) return renderBrowse(notesCache);

  el.browseBody.replaceChildren(emptyState('Loading', 'Fetching your notes.'));
  try {
    /* Pending is a nicety: never let it fail the whole view. */
    const [notes, pending, suggestions] = await Promise.all([
      fetchNotes(),
      fetchPending().catch(() => []),
      fetchSuggestions().catch(() => ({ data: { groups: [] } })),
    ]);
    notesCache = notes;
    pendingCache = pending;
    suggestionsCache = suggestions.data;
    urlIndex = buildUrlIndex(notes);
    browseLoaded = true;
    freshIds = findFreshlySwept(notes);
    announceSweep(freshIds.size);
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
    /* GitHub says this when an App is installed but lacks the permission the
     * endpoint needs. Distinct from 404, which means it cannot see the repo. */
    if (err.status === 403 && /not accessible by integration/i.test(err.message)) {
      el.browseBody.replaceChildren(
        emptyState(
          'The app is installed but not permitted',
          'Winnow needs Contents: Read and write. Grant it on the app, then approve the change on the installation, since new permissions do not apply until accepted.',
          { label: 'Review permissions', href: 'https://github.com/settings/installations' }
        )
      );
      return;
    }

    el.browseBody.replaceChildren(emptyState('Could not load notes', err.message));
  }
}

/* The tags printed on each note are the filter control. A separate wall of
 * chips above six notes was more chrome than content, and tags grow about four
 * times faster than notes, so it only got worse. */
function renderFilterBar(data) {
  el.filterBar.replaceChildren();

  if (activeTag) {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'tag-chip is-on';
    pill.textContent = `${activeTag}  \u00d7`;
    pill.setAttribute('aria-label', `Clear the ${activeTag} filter`);
    pill.addEventListener('click', () => {
      activeTag = null;
      renderBrowse(notesCache);
    });
    el.filterBar.append(pill);
    el.filterBar.hidden = false;
    return;
  }

  const counts = new Map();
  let total = 0;
  for (const cat of (data && data.categories) || []) {
    for (const note of cat.notes || []) {
      total += 1;
      for (const tag of note.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }

  if (total < TAG_FILTER_FROM || counts.size < 2) {
    el.filterBar.hidden = true;
    return;
  }

  /* Only the tags that group things. The long tail is what search is for. */
  const top = [...counts.entries()]
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8);

  if (!top.length) {
    el.filterBar.hidden = true;
    return;
  }

  const details = document.createElement('details');
  details.className = 'filter-tags';
  const summary = document.createElement('summary');
  summary.textContent = 'Filter by tag';
  details.append(summary);

  const row = document.createElement('div');
  row.className = 'filter-row';
  for (const [tag, count] of top) {
    row.append(tagChip(tag, count));
  }
  details.append(row);
  el.filterBar.append(details);
  el.filterBar.hidden = false;
}

function tagChip(tag, count) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'tag-chip' + (activeTag === tag ? ' is-on' : '');
  chip.textContent = count ? `${tag} ${count}` : tag;
  chip.setAttribute('aria-pressed', String(activeTag === tag));
  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    activeTag = activeTag === tag ? null : tag;
    renderBrowse(notesCache);
  });
  return chip;
}

function renderBrowse(data) {
  const q = el.search.value.trim().toLowerCase();
  const categories = (data && data.categories) || [];

  renderFilterBar(data);

  const matching = categories
    .map((cat) => ({
      ...cat,
      notes: (cat.notes || []).filter(
        (n) =>
          (!q || noteText(n).includes(q)) &&
          (!activeTag || (n.tags || []).includes(activeTag))
      ),
    }))
    .filter((cat) => cat.notes.length);

  el.browseBody.replaceChildren();

  /* Search filters filed notes only; pending items are transient, and hiding
   * them mid-search would look like they had been lost. */
  /* A filtered view is a search result, not the whole desk: pending captures
   * and merge prompts would just be noise in it. */
  const quiet = Boolean(q || activeTag);
  const extras =
    !quiet && (pendingCache.length || suggestionGroups().length || categorySuggestions().length);
  if (!quiet && pendingCache.length) el.browseBody.append(renderPending(pendingCache));
  if (!quiet && suggestionGroups().length) {
    el.browseBody.append(renderSuggestions(suggestionGroups()));
  }
  if (!quiet && categorySuggestions().length) {
    el.browseBody.append(renderCategorySuggestions(categorySuggestions()));
  }

  if (!matching.length && !extras) {
    el.browseBody.append(
      quiet
        ? emptyState(
            'No matches',
            q
              ? `Nothing matches "${el.search.value.trim()}".`
              : `No notes tagged "${activeTag}".`
          )
        : emptyState('Nothing winnowed yet', 'Capture some notes and let the daily sweep sort them.')
    );
    return;
  }

  for (const cat of matching) {
    el.browseBody.append(renderCategory(cat));
  }
}

/* Only offer a group whose notes all still exist; deletes happen between the
 * weekly run and now. */
function suggestionGroups() {
  const groups = (suggestionsCache && suggestionsCache.groups) || [];
  if (!groups.length || !notesCache) return [];
  const alive = new Set(
    (notesCache.categories || []).flatMap((c) => (c.notes || []).map((n) => n.id))
  );
  return groups.filter((g) => (g.noteIds || []).length > 1 && g.noteIds.every((id) => alive.has(id)));
}

function categorySuggestions() {
  const groups = (suggestionsCache && suggestionsCache.categoryGroups) || [];
  if (!groups.length || !notesCache) return [];
  const alive = new Set((notesCache.categories || []).map((c) => c.name));
  return groups.filter(
    (g) => (g.categories || []).length > 1 && g.categories.every((c) => alive.has(c))
  );
}

function noteText(n) {
  const links = (n.links || []).map((l) => `${l.url} ${l.label}`).join(' ');
  return [n.title, n.summary, n.url, links, (n.tags || []).join(' ')]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function renderCategory(cat) {
  const section = document.createElement('section');
  section.className = 'category';

  const h3 = document.createElement('h3');
  h3.className = 'cat-head';
  const name = document.createElement('span');
  name.textContent = cat.name;

  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'cat-edit';
  edit.textContent = 'Rename';
  edit.setAttribute('aria-label', `Rename or merge ${cat.name}`);
  edit.addEventListener('click', () => openRename(cat.name));

  h3.append(name, edit);

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
  li.className = 'note' + (freshIds.has(n.id) ? ' is-fresh' : '');

  /* Older notes predate `links` and only carry a single `url`. */
  const links = (Array.isArray(n.links) ? n.links : n.url ? [{ url: n.url, label: n.title }] : [])
    .filter((l) => l && isHttpUrl(l.url));
  const single = links.length === 1;

  const title = document.createElement('p');
  title.className = 'n-title';
  if (single) {
    const a = document.createElement('a');
    a.href = links[0].url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = n.title || links[0].url;
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

  /* With several links, the title cannot stand in for them, so list them all. */
  if (!single && links.length) {
    const list = document.createElement('ul');
    list.className = 'n-links';
    for (const l of links) {
      const item = document.createElement('li');
      const a = document.createElement('a');
      a.href = l.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = l.label || l.url;
      item.append(a);
      list.append(item);
    }
    li.append(list);
  }

  /* Bodies are not in the index any more, so fetch on first open. Rambling
   * notes lose the most to summarizing, so keep the original one tap away. */
  if (n.path) {
    const details = document.createElement('details');
    details.className = 'n-original';
    const sum = document.createElement('summary');
    sum.textContent = 'Show original';
    const pre = document.createElement('p');
    pre.className = 'n-original-text';
    details.append(sum, pre);

    let loaded = false;
    details.addEventListener('toggle', async () => {
      if (!details.open || loaded) return;
      loaded = true;
      pre.textContent = 'Loading...';
      try {
        pre.textContent = originalFrom((await fetchNoteFile(n)).raw) || '(empty)';
      } catch (err) {
        loaded = false;
        pre.textContent = `Could not load it: ${err.message}`;
      }
    });
    li.append(details);
  }

  const foot = document.createElement('div');
  foot.className = 'n-foot';
  for (const t of n.tags || []) {
    /* Already looks like a chip, so make it behave like one. */
    foot.append(tagChip(t, null));
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
  del.addEventListener('click', () =>
    askDelete(n.title || n.summary || n.id, () => deleteNote(n))
  );

  /* Card first so Tab reaches the note's link before the delete button. */
  row.append(li, del);

  if (selectMode) {
    row.classList.add('is-selectable');
    if (selected.has(n.id)) row.classList.add('is-selected');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'note-pick';
    box.checked = selected.has(n.id);
    box.setAttribute('aria-label', `Select ${n.title || 'note'}`);
    box.addEventListener('change', () => {
      if (box.checked) selected.add(n.id);
      else selected.delete(n.id);
      row.classList.toggle('is-selected', box.checked);
      updateSelectBar();
    });
    li.prepend(box);
  } else {
    attachSwipe(row, li);
  }
  return row;
}

/* --------------------------------------------------------- select mode */

function updateSelectBar() {
  const n = selected.size;
  el.selectCount.textContent =
    n === 0 ? 'Pick two or more notes to merge' : `${n} selected`;
  el.mergeBtn.disabled = n < 2;
}

function setSelectMode(on) {
  selectMode = on;
  selected.clear();
  el.selectBar.hidden = !on;
  el.selectBtn.textContent = on ? 'Done' : 'Select';
  el.selectBtn.setAttribute('aria-pressed', String(on));
  /* Swipe-to-delete and tap-to-select on the same card would fight. */
  closeOpenRow();
  updateSelectBar();
  if (notesCache) renderBrowse(notesCache);
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

/* { label, run } so the same dialog covers filed notes and pending captures. */
let pendingDelete = null;

const DELETE_COPY = {
  title: 'Delete this note?',
  detail:
    'Removed from Winnow and from your notes repo, archived copy included. Git keeps every version, so it can still be recovered from history.',
  confirmLabel: 'Delete',
  danger: true,
};

function askDelete(label, run, copy = DELETE_COPY) {
  const c = { ...DELETE_COPY, ...copy };
  pendingDelete = { label, run, confirmLabel: c.confirmLabel };
  el.confirmTitle.textContent = c.title;
  el.confirmDetail.textContent = c.detail;
  el.confirmBody.textContent = label;
  el.confirmYes.textContent = c.confirmLabel;
  el.confirmYes.classList.toggle('is-danger', c.danger !== false);
  el.confirm.hidden = false;
  el.confirmYes.focus();
}

/* Merging keeps everything, so it should not wear the delete dialog's clothes. */
const MERGE_COPY = {
  title: 'Merge into one note?',
  detail:
    'The oldest note keeps its title, category and date, and gains the others\u2019 links, tags and text. Nothing is discarded.',
  confirmLabel: 'Merge',
  danger: false,
};

function closeConfirm() {
  pendingDelete = null;
  el.confirm.hidden = true;
  el.confirmYes.disabled = false;
  el.confirmYes.textContent = 'Delete';
  el.confirmYes.classList.add('is-danger');
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
  /* The markdown file is the record, so removing it is the real delete. */
  if (note.path) {
    const { sha } = await fetchNoteFile(note);
    await gh(filePath(note.path), {
      method: 'DELETE',
      body: JSON.stringify({
        message: `delete: ${firstLine(note.title || note.id, 60)}`,
        sha,
      }),
    });
  }

  /* The index is derived, so this is only to keep the screen honest until the
   * next sweep rebuilds it. A failure here self-heals. */
  try {
    const { data, sha } = await fetchNotesFile();
    const next = withoutNote(data, note.id);
    await gh(NOTES_PATH(), {
      method: 'PUT',
      body: JSON.stringify({
        message: `index: drop ${firstLine(note.title || note.id, 40)}`,
        content: toBase64(JSON.stringify(next, null, 2) + '\n'),
        sha,
      }),
    });
    notesCache = next;
  } catch {
    notesCache = withoutNote(notesCache, note.id);
  }

  urlIndex = buildUrlIndex(notesCache);
  closeOpenRow();
  renderBrowse(notesCache);
}

/* ------------------------------------------------------ duplicate check */

const TRACKING_PARAM = /^(utm_.*|fbclid|gclid|mc_[ce]id|igshid|si|ref|ref_src|spm|_hsenc|_hsmi)$/i;

/* Two URLs that differ only by tracking junk, scheme, www or a trailing slash
 * are the same link as far as anyone reading their own notes is concerned. */
function normalizeUrl(raw) {
  try {
    const u = new URL(String(raw).trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.protocol = 'https:';
    u.hash = '';
    u.hostname = u.hostname.replace(/^www\./i, '').toLowerCase();
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
    }
    u.searchParams.sort();
    return u.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function urlsIn(text) {
  const found = String(text).match(/https?:\/\/[^\s<>()[\]{}"']+/g) || [];
  return found.map((u) => u.replace(/[.,;:!?)\]]+$/, ''));
}

/* normalized url -> { note, category }, rebuilt whenever notes change. */
function buildUrlIndex(data) {
  const index = new Map();
  for (const cat of (data && data.categories) || []) {
    for (const note of cat.notes || []) {
      const urls = (note.links || []).map((l) => l.url).concat(note.url ? [note.url] : []);
      for (const raw of urls) {
        const key = normalizeUrl(raw);
        if (key && !index.has(key)) index.set(key, { note, category: cat.name });
      }
    }
  }
  return index;
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

/* ------------------------------------------------------------- motion */

/* Drifting motes, not sparkles: the whole metaphor is grain falling and chaff
 * drifting. CSS keyframes on transform only, so the compositor handles it and
 * there is no animation loop to burn battery. */
function seedMotes() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const COUNT = 18;
  for (let i = 0; i < COUNT; i++) {
    const mote = document.createElement('span');
    mote.className = 'mote';
    /* Staggered durations and delays so the field never looks like a loop. */
    mote.style.left = `${(i * 97) % 100}%`;
    mote.style.animationDuration = `${34 + ((i * 7) % 26)}s`;
    mote.style.animationDelay = `${-(i * 5) % 40}s`;
    mote.style.setProperty('--drift', `${((i % 5) - 2) * 16}px`);
    mote.style.setProperty('--size', `${2 + (i % 3)}px`);
    el.motes.append(mote);
  }

  /* The room goes still while you write. Fades rather than a hard stop, and it
   * answers the one real objection to ambient motion in a text field. */
  el.note.addEventListener('focus', () => el.motes.classList.add('is-still'));
  el.note.addEventListener('blur', () => el.motes.classList.remove('is-still'));
}

/* The note visibly falls into the pile. This is the interaction you will do
 * thousands of times, so it is the one worth making feel like something. */
function animateCapture(text) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const box = el.note.getBoundingClientRect();
  const ghost = document.createElement('div');
  ghost.className = 'capture-ghost';
  ghost.textContent = firstLine(text, 60);
  ghost.style.left = `${box.left + 18}px`;
  ghost.style.top = `${box.top + 18}px`;
  ghost.style.width = `${box.width - 36}px`;
  document.body.append(ghost);
  ghost.addEventListener('animationend', () => ghost.remove());
}

/* --------------------------------------------------- overnight reveal */

/* Something real happens while you sleep and the app used to say nothing about
 * it. Remember which notes you have already seen, and greet the rest. */
function loadSeen() {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

function markSeen(ids) {
  /* Bounded: only the ids currently filed matter, older ones cannot reappear. */
  localStorage.setItem(SEEN_KEY, JSON.stringify([...ids].slice(-2000)));
}

function findFreshlySwept(data) {
  const ids = new Set(
    (data.categories || []).flatMap((c) => (c.notes || []).map((n) => n.id))
  );
  const seen = loadSeen();

  /* First run has nothing to compare against, so nothing is "new". */
  if (!seen.size) {
    markSeen(ids);
    return new Set();
  }

  const fresh = new Set([...ids].filter((id) => !seen.has(id)));
  markSeen(ids);
  return fresh;
}

function announceSweep(count) {
  if (!count) {
    el.swept.hidden = true;
    return;
  }
  el.swept.textContent =
    count === 1 ? '1 note sorted since you last looked' : `${count} notes sorted since you last looked`;
  el.swept.hidden = false;
}

/* ------------------------------------------------- rename a category */

let renaming = null;

function openRename(from) {
  renaming = from;
  el.renameTitle.textContent = `Rename "${from}"`;
  el.renameInput.value = from;
  el.renameErr.hidden = true;

  /* Offer the other categories, so merging is a choice rather than a trick you
   * have to know about. */
  el.renameOptions.replaceChildren();
  for (const cat of (notesCache && notesCache.categories) || []) {
    if (cat.name === from) continue;
    const option = document.createElement('option');
    option.value = cat.name;
    el.renameOptions.append(option);
  }

  el.rename.hidden = false;
  el.renameInput.focus();
  el.renameInput.select();
}

function closeRename() {
  renaming = null;
  el.rename.hidden = true;
  el.renameSave.disabled = false;
  el.renameSave.textContent = 'Move';
}

el.renameCancel.addEventListener('click', closeRename);
el.rename.addEventListener('click', (e) => {
  if (e.target === el.rename) closeRename();
});

el.renameSave.addEventListener('click', async () => {
  const from = renaming;
  const to = el.renameInput.value.trim();
  if (!from) return;
  if (!to) {
    el.renameErr.textContent = 'Give the category a name.';
    el.renameErr.hidden = false;
    return;
  }

  const merging = ((notesCache && notesCache.categories) || []).some((c) => c.name === to);
  el.renameSave.disabled = true;
  el.renameSave.textContent = merging ? 'Merging' : 'Renaming';
  try {
    await moveCategory(from, to);
    closeRename();
    renderBrowse(notesCache);
    toast(merging ? `Merged into ${to}` : `Renamed to ${to}`);
  } catch (err) {
    el.renameSave.disabled = false;
    el.renameSave.textContent = 'Move';
    el.renameErr.textContent = err.message;
    el.renameErr.hidden = false;
  }
});

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
  el.cfgErr.hidden = true;

  const isConnected = connected();
  el.cfgForget.hidden = !isConnected;
  el.cfgClose.hidden = !isConnected;
  el.cfgLink.hidden = !cfg;
  el.signIn.hidden = !oauthConfigured || Boolean(session);
  el.signInNote.hidden = el.signIn.hidden;

  /* Already connected? Say so. Leading with token instructions reads like
   * something is wrong when nothing is. */
  el.sheetTitle.textContent = isConnected ? 'Winnow' : 'Connect Winnow';
  el.introConnected.hidden = !isConnected;
  el.introSetup.hidden = isConnected;
  el.tokenHelp.hidden = Boolean(session);
  /* The token fallback is noise while a session is working. Disconnect first. */
  el.cfgAdvanced.hidden = Boolean(session);

  if (isConnected) {
    el.statusText.textContent = session ? 'Signed in with GitHub' : 'Connected with a token';
    el.statusDetail.textContent = session
      ? `Reading and writing ${owner()}/${repo()}. Access renews on its own and can be revoked from GitHub at any time.`
      : `Reading and writing ${owner()}/${repo()} with a token stored in this browser.`;
  }

  /* Without a sign-in button there is nothing above the fold, so open the
   * token section rather than showing an apparently empty dialog. */
  el.cfgAdvanced.open = el.signIn.hidden && !isConnected;

  el.sheet.hidden = false;

  /* Never focus something hidden: it silently does nothing and strands the
   * keyboard outside the dialog. */
  const focusTarget = !el.signIn.hidden
    ? el.signIn
    : isConnected
      ? el.cfgForget
      : el.cfgToken;
  focusTarget.focus();
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
  animateCapture(text);
  enqueue(text);
  el.note.value = '';
  updateHint();
  checkDuplicates();

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

let dupeTimer;
el.note.addEventListener('input', () => {
  updateHint();
  clearTimeout(dupeTimer);
  dupeTimer = setTimeout(checkDuplicates, 250);
});

/* The cheapest duplicate to deal with is the one never written. Warn while the
 * note is still in the box, rather than merging it away afterwards. */
function checkDuplicates() {
  el.dupeWarn.replaceChildren();
  el.dupeWarn.hidden = true;
  if (!urlIndex || !urlIndex.size) return;

  const seen = new Set();
  const hits = [];
  for (const raw of urlsIn(el.note.value)) {
    const key = normalizeUrl(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const hit = urlIndex.get(key);
    if (hit) hits.push(hit);
  }
  if (!hits.length) return;

  const head = document.createElement('p');
  head.className = 'dupe-head';
  head.textContent =
    hits.length === 1 ? 'You have saved this link before' : 'You have saved these links before';
  el.dupeWarn.append(head);

  for (const { note, category } of hits) {
    const line = document.createElement('p');
    line.className = 'dupe-line';
    line.textContent = `${note.title} · ${category} · ${formatDate(note.captured)}`;
    el.dupeWarn.append(line);
  }

  const note = document.createElement('p');
  note.className = 'dupe-foot';
  note.textContent = 'Saving anyway is fine: the sweep folds it into the existing note.';
  el.dupeWarn.append(note);

  el.dupeWarn.hidden = false;
}

/* Browse loads notes lazily, but the duplicate check needs them on the Capture
 * tab. Warm the cache quietly and never let it surface an error. */
async function prefetchNotes() {
  if (!connected() || notesCache) return;
  try {
    notesCache = await fetchNotes();
    urlIndex = buildUrlIndex(notesCache);
    checkDuplicates();
  } catch {
    /* Browse will report properly if something is actually wrong. */
  }
}

function updateHint() {
  const n = el.note.value.trim().length;
  el.hint.textContent = n ? `${n} character${n === 1 ? '' : 's'}` : '';
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => showView(tab.dataset.view));
}

el.settingsBtn.addEventListener('click', openSheet);
el.cfgClose.addEventListener('click', closeSheet);

el.sheet.addEventListener('click', (e) => {
  /* Dismiss only when there is something to go back to. */
  if (e.target === el.sheet && connected()) closeSheet();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!el.confirm.hidden) return closeConfirm();
  if (!el.rename.hidden) return closeRename();
  if (openRow) return closeOpenRow();
  if (!el.sheet.hidden && connected()) closeSheet();
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
  const job = pendingDelete;
  if (!job) return;

  el.confirmYes.disabled = true;
  el.confirmYes.textContent = job.confirmLabel === 'Merge' ? 'Merging' : 'Deleting';
  try {
    await job.run();
    const done = job.confirmLabel === 'Merge' ? 'Merged' : 'Deleted';
    closeConfirm();
    toast(done);
  } catch (err) {
    closeConfirm();
    toast(err.message, true);
  }
});

el.selectBtn.addEventListener('click', () => setSelectMode(!selectMode));

el.mergeBtn.addEventListener('click', () => {
  const ids = [...selected];
  if (ids.length < 2) return;
  askDelete(
    `${ids.length} notes`,
    async () => {
      await applyMerge(ids);
      setSelectMode(false);
    },
    MERGE_COPY
  );
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

/* An installed home-screen app can sit on a stale worker for days, which looks
 * exactly like a fix that never shipped. Check for a new one on every launch,
 * and reload once when it takes over. */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    /* No controller before means this is the first install, not an update.
     * Reloading there would be a pointless flash on first run. */
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });

  navigator.serviceWorker
    .register('sw.js')
    .then((reg) => {
      reg.update().catch(() => {});
      /* Foregrounding the app is the moment a stale build is most likely. */
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    })
    .catch(() => {
      /* offline shell is a bonus; capture still queues without it */
    });
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

  if (connected()) {
    flushQueue({ quiet: true });
    prefetchNotes();
  }

  seedMotes();
  registerServiceWorker();
}

boot();
