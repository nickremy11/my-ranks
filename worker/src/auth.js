/**
 * Auth module for my-ranks-worker.
 * Handles session validation, login, and logout using the shared sleeper-helper-db.
 * Registration is intentionally excluded — accounts are created at helper.ffhistorian.com.
 */

const SESSION_TTL    = 30 * 24 * 60 * 60;
const SESSION_TTL_MS = SESSION_TTL * 1000;

function getSessionId(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match  = cookie.match(/(?:^|;\s*)sh_session=([^;]+)/);
  return match ? match[1] : null;
}

function randomHex(bytes) {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyPassword(password, storedHash, storedSalt) {
  const salt   = Uint8Array.from(atob(storedSalt), c => c.charCodeAt(0));
  const keyMat = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits   = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, keyMat, 256);
  return btoa(String.fromCharCode(...new Uint8Array(bits))) === storedHash;
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

async function createSession(userId, env) {
  const id = randomHex(32);
  await env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(id, userId, Date.now() + SESSION_TTL_MS).run();
  const cookie = `sh_session=${id}; HttpOnly; Secure; SameSite=Strict; Domain=.ffhistorian.com; Max-Age=${SESSION_TTL}; Path=/`;
  return { sessionId: id, cookie };
}

export async function handleLogin(request, env, corsHeaders) {
  let body;
  try { body = await request.json(); } catch { return errRes('Invalid JSON', 400, corsHeaders); }
  const { email, password } = body ?? {};
  if (!email || !password) return errRes('Email and password required', 400, corsHeaders);

  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?')
    .bind(String(email).toLowerCase()).first();
  if (!user) return errRes('Invalid email or password', 401, corsHeaders);
  const ok = await verifyPassword(String(password), user.password_hash, user.password_salt);
  if (!ok)   return errRes('Invalid email or password', 401, corsHeaders);

  const { cookie } = await createSession(user.id, env);
  const headers = { ...corsHeaders, 'Content-Type': 'application/json;charset=UTF-8', 'Set-Cookie': cookie };
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

export async function handleLogout(request, env, corsHeaders) {
  const sessionId = getSessionId(request);
  if (sessionId) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
  }
  const clearCookie = `sh_session=; HttpOnly; Secure; SameSite=Strict; Domain=.ffhistorian.com; Max-Age=0; Path=/`;
  const headers = { ...corsHeaders, 'Content-Type': 'application/json;charset=UTF-8', 'Set-Cookie': clearCookie };
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

export async function handleMe(request, env, corsHeaders) {
  const user = await getAuthUser(request, env);
  const headers = { ...corsHeaders, 'Content-Type': 'application/json;charset=UTF-8' };
  if (!user) return new Response(JSON.stringify({ user: null }), { status: 200, headers });
  return new Response(JSON.stringify({ user: { user_id: user.user_id, email: user.email, name: user.name } }), { status: 200, headers });
}

function errRes(msg, status, corsHeaders) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json;charset=UTF-8' },
  });
}
