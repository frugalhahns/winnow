/* Winnow auth broker.
 *
 * The only reason this exists: GitHub requires a client secret to turn an
 * OAuth code into a token, and refuses PKCE, so a static page cannot do it.
 * This Worker holds that secret and does nothing else.
 *
 * It never sees a note. Captures and browsing go straight from the browser to
 * api.github.com. This is touched only at sign-in and at token refresh, which
 * is a handful of requests per device per day.
 *
 * Endpoints, both POST and both JSON:
 *   /exchange  { code }           -> { access_token, expires_in, refresh_token, ... }
 *   /refresh   { refresh_token }  -> same shape
 *
 * Secrets (wrangler secret put NAME):
 *   GITHUB_CLIENT_SECRET
 * Vars (wrangler.toml):
 *   GITHUB_CLIENT_ID, ALLOWED_ORIGINS
 */

const TOKEN_URL = 'https://github.com/login/oauth/access_token';

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = allowOrigin(origin, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(allowed) });
    }

    /* An unknown origin gets nothing. The code is single-use and short-lived,
     * but there is no reason to let any other site talk to this at all. */
    if (!allowed) {
      return json({ error: 'origin_not_allowed' }, 403, cors(null));
    }
    if (request.method !== 'POST') {
      return json({ error: 'method_not_allowed' }, 405, cors(allowed));
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'invalid_json' }, 400, cors(allowed));
    }

    const path = new URL(request.url).pathname.replace(/\/+$/, '');

    if (path === '/exchange') {
      if (!body.code) return json({ error: 'missing_code' }, 400, cors(allowed));
      return githubToken(
        {
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code: body.code,
          ...(body.redirect_uri ? { redirect_uri: body.redirect_uri } : {}),
        },
        allowed
      );
    }

    if (path === '/refresh') {
      if (!body.refresh_token) {
        return json({ error: 'missing_refresh_token' }, 400, cors(allowed));
      }
      return githubToken(
        {
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          grant_type: 'refresh_token',
          refresh_token: body.refresh_token,
        },
        allowed
      );
    }

    return json({ error: 'not_found' }, 404, cors(allowed));
  },
};

async function githubToken(params, allowed) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(params),
  });

  const data = await res.json().catch(() => ({ error: 'github_unreadable' }));

  /* GitHub answers 200 with an error field on bad codes, so trust the body. */
  if (!res.ok || data.error) {
    return json(
      { error: data.error || 'github_error', description: data.error_description || null },
      400,
      cors(allowed)
    );
  }

  return json(
    {
      access_token: data.access_token,
      expires_in: data.expires_in ?? null,
      refresh_token: data.refresh_token ?? null,
      refresh_token_expires_in: data.refresh_token_expires_in ?? null,
      token_type: data.token_type ?? 'bearer',
    },
    200,
    cors(allowed)
  );
}

function allowOrigin(origin, env) {
  const list = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.includes(origin) ? origin : null;
}

function cors(origin) {
  const headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function json(payload, status, headers) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      /* Tokens must never be cached by anything in the path. */
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}
