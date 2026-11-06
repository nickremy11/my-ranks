/**
 * Session lookup for my-ranks-worker, against the shared sleeper-helper-db.
 * Signing in, signing up and password resets all happen on helper's API
 * (helper.ffhistorian.com/api/auth/*), so there is one set of account rules; the
 * sh_session cookie it sets is scoped to .ffhistorian.com and arrives here too.
 */

function getSessionId(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match  = cookie.match(/(?:^|;\s*)sh_session=([^;]+)/);
  return match ? match[1] : null;
}

export async function getAuthUser(request, env) {
  const sessionId = getSessionId(request);
  if (!sessionId) return null;
  const row = await env.DB.prepare(
    `SELECT s.user_id, s.expires_at, u.email, u.name
     FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.id = ?`
  ).bind(sessionId).first();
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
    return null;
  }
  return row;
}
