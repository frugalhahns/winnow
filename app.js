/* Winnow: capture client.
 *
 * Writes raw notes to `inbox/*.md` in a private GitHub repo via the Contents API.
 * A scheduled Action in that repo sweeps the inbox, categorizes with Gemini,
 * and rewrites `data/notes.json`, which the Browse tab reads back.
 *
 * The token lives in localStorage on this device only. Scope it to one repo,
 * Contents: read and write. Nothing here ever renders note text as HTML.
 */

const CFG_KEY = 'winnow.cfg';
const QUEUE_KEY = 'winnow.queue';
const API = 'https://api.github.com';

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
  settingsBtn: $('#settings-btn'),
  toast: $('#toast'),
};

let cfg = loadCfg();
let notesCache = null;

/* ---------------------------------------------------------------- config */

function loadCfg() {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    return raw ? JSON.parse(raw) : null;
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

/* ------------------------------------------------------------ github api */

async function gh(path, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${cfg.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers || {}),
    },
  });
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
  await gh(`/repos/${cfg.owner}/${cfg.repo}/contents/${inboxPath(when, item.id)}`, {
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
  if (!cfg) return;
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

async function fetchNotes() {
  const res = await gh(
    `/repos/${cfg.owner}/${cfg.repo}/contents/data/notes.json`,
    { headers: { Accept: 'application/vnd.github+json' } }
  );
  const body = await res.json();
  return JSON.parse(fromBase64(body.content));
}

async function loadBrowse({ force = false } = {}) {
  if (notesCache && !force) return renderBrowse(notesCache);

  el.browseBody.replaceChildren(emptyState('Loading', 'Fetching your notes.'));
  try {
    notesCache = await fetchNotes();
    renderBrowse(notesCache);
  } catch (err) {
    if (err.status === 404) {
      el.browseBody.replaceChildren(
        emptyState(
          'Nothing winnowed yet',
          'The daily sweep has not run. Capture a few notes, then trigger the workflow in your notes repo, or wait for the next scheduled run.'
        )
      );
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
  const li = document.createElement('li');
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

  return li;
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

function emptyState(headline, detail) {
  const div = document.createElement('div');
  div.className = 'empty';
  const strong = document.createElement('strong');
  strong.textContent = headline;
  div.append(strong, document.createTextNode(detail));
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
  if (cfg) {
    el.cfgOwner.value = cfg.owner;
    el.cfgRepo.value = cfg.repo;
    el.cfgToken.value = cfg.token;
    el.cfgForget.hidden = false;
  }
  el.cfgErr.hidden = true;
  el.sheet.hidden = false;
  (cfg ? el.cfgToken : el.cfgOwner).focus();
}

function closeSheet() {
  el.sheet.hidden = true;
}

/* ---------------------------------------------------------------- events */

el.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = el.note.value.trim();
  if (!text) return;

  if (!cfg) {
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
  if (e.key === 'Escape' && !el.sheet.hidden && cfg) closeSheet();
});

el.cfgSave.addEventListener('click', async () => {
  const next = {
    owner: el.cfgOwner.value.trim(),
    repo: el.cfgRepo.value.trim(),
    token: el.cfgToken.value.trim(),
  };
  if (!next.owner || !next.repo || !next.token) {
    return showCfgError('All three fields are required.');
  }

  el.cfgSave.disabled = true;
  el.cfgSave.textContent = 'Verifying';
  const prev = cfg;
  cfg = next;
  try {
    /* Confirms the token can actually reach this repo before we persist it. */
    await gh(`/repos/${next.owner}/${next.repo}`);
    saveCfg(next);
    closeSheet();
    toast('Connected');
    flushQueue({ quiet: true });
  } catch (err) {
    cfg = prev;
    showCfgError(
      err.status === 404
        ? 'Repo not found, or the token has no access to it. Check the name and that the token grants Contents access to this repo.'
        : err.message
    );
  } finally {
    el.cfgSave.disabled = false;
    el.cfgSave.textContent = 'Verify & save';
  }
});

el.cfgForget.addEventListener('click', () => {
  clearCfg();
  el.cfgToken.value = '';
  el.cfgForget.hidden = true;
  notesCache = null;
  toast('Token removed from this device');
});

function showCfgError(message) {
  el.cfgErr.textContent = message;
  el.cfgErr.hidden = false;
}

el.refresh.addEventListener('click', () => loadBrowse({ force: true }));

let searchTimer;
el.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => notesCache && renderBrowse(notesCache), 120);
});

window.addEventListener('online', () => flushQueue({ quiet: true }));

/* ----------------------------------------------------------------- boot */

function boot() {
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

  if (!cfg) openSheet();
  else flushQueue({ quiet: true });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {
      /* offline shell is a bonus; capture still queues without it */
    });
  }
}

boot();
