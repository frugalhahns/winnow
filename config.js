/* Where your notes live.
 *
 * Neither of these is a secret: they are visible in this public repo and in
 * every API request the app makes. Only the token is sensitive, so only the
 * token is ever asked for.
 *
 * Forking Winnow? Change these two lines and you are done.
 */

export const CONFIG = {
  owner: 'frugalhahns',
  repo: 'winnow-store',

  /* Sign in with GitHub. Both values are public by design: the client id is
   * visible in every authorize URL, and the Worker URL is just an endpoint.
   * The client secret lives only in the Worker.
   *
   * Leave either blank and the button hides, falling back to a token. */
  clientId: 'Iv23lidnKAXSsoshm1ra',
  authWorker: 'https://winnow-auth.frugalhahns.workers.dev',
};
