/**
 * My Ranks — Cloudflare Worker
 *
 * Routes:
 *   GET    /api/auth/me             → current user (shared-auth.js compatible)
 *   POST   /api/auth/login          → login, set .ffhistorian.com session cookie
 *   POST   /api/auth/logout         → clear session cookie
 *   POST   /api/auth/register       → returns error (register at helper.ffhistorian.com)
 *   GET    /api/myranks/data        → { rankings, picks } for logged-in user
 *   POST   /api/myranks/import      → bulk import from CSV parse (clears + replaces)
 *   PATCH  /api/myranks/player      → move player to new tier
 *   DELETE /api/myranks/player      → remove player
 *   POST   /api/myranks/add-player  → manually add a player
 *   PATCH  /api/myranks/pick        → assign/unassign pick to tier
 *
 * D1 binding: DB (shared sleeper-helper-db)
 */

import { getAuthUser, handleLogin, handleLogout, handleMe } from './auth.js';

const ALLOWED_ORIGINS = new Set([
  'https://myranks.ffhistorian.com',
  'https://ffhistorian.com',
  'https://helper.ffhistorian.com',
]);

function getCors(request) {
  const origin = (request && request.headers.get('Origin')) || '';
  const allow  = ALLOWED_ORIGINS.has(origin) ? origin : 'https://myranks.ffhistorian.com';
  return {
    'Access-Control-Allow-Origin':      allow,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods':     'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':     'Content-Type',
  };
}

function json(data, status = 200, cors = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json;charset=UTF-8' },
  });
}

function err(msg, status = 400, cors = {}) {
  return json({ error: msg }, status, cors);
}

// ── Rankings handlers ─────────────────────────────────────────────────────────

async function handleGetData(request, env, cors) {
  const user = await getAuthUser(request, env);
  if (!user) return err('Not authenticated', 401, cors);

  const [rankingsRes, picksRes] = await Promise.all([
    env.DB.prepare(
      'SELECT player_name, team, position, tier FROM user_rankings WHERE user_id = ? ORDER BY tier, position, player_name'
    ).bind(user.user_id).all(),
    env.DB.prepare(
      'SELECT pick_name, tier FROM user_tier_picks WHERE user_id = ? ORDER BY tier, pick_name'
    ).bind(user.user_id).all(),
  ]);

  return json({ rankings: rankingsRes.results, picks: picksRes.results }, 200, cors);
}

async function handleImport(request, env, cors) {
  const user = await getAuthUser(request, env);
  if (!user) return err('Not authenticated', 401, cors);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON', 400, cors); }

  const players = body?.players;
  if (!Array.isArray(players)) return err('players array required', 400, cors);

  const VALID_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);
  for (const p of players) {
    if (!p.player_name || typeof p.player_name !== 'string') return err('Each player needs player_name', 400, cors);
    if (!VALID_POSITIONS.has(p.position)) return err(`Invalid position: ${p.position}`, 400, cors);
    if (!Number.isInteger(p.tier) || p.tier < 1) return err('tier must be a positive integer', 400, cors);
  }

  await env.DB.prepare('DELETE FROM user_rankings WHERE user_id = ?').bind(user.user_id).run();

  const CHUNK = 25;
  const now   = Date.now();
  for (let i = 0; i < players.length; i += CHUNK) {
    const chunk = players.slice(i, i + CHUNK);
    const stmts = chunk.map(p =>
      env.DB.prepare(
        'INSERT OR REPLACE INTO user_rankings (user_id, player_name, team, position, tier, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(user.user_id, p.player_name.trim(), (p.team || '').trim(), p.position, p.tier, now)
    );
    await env.DB.batch(stmts);
  }

  return json({ ok: true, imported: players.length }, 200, cors);
}

async function handlePatchPlayer(request, env, cors) {
  const user = await getAuthUser(request, env);
  if (!user) return err('Not authenticated', 401, cors);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON', 400, cors); }

  const { player_name, tier } = body ?? {};
  if (!player_name) return err('player_name required', 400, cors);
  if (!Number.isInteger(tier) || tier < 1) return err('tier must be a positive integer', 400, cors);

  const res = await env.DB.prepare(
    'UPDATE user_rankings SET tier = ?, updated_at = ? WHERE user_id = ? AND player_name = ?'
  ).bind(tier, Date.now(), user.user_id, player_name).run();

  if (res.meta.changes === 0) return err('Player not found', 404, cors);
  return json({ ok: true }, 200, cors);
}

async function handleDeletePlayer(request, env, cors) {
  const user = await getAuthUser(request, env);
  if (!user) return err('Not authenticated', 401, cors);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON', 400, cors); }

  const { player_name } = body ?? {};
  if (!player_name) return err('player_name required', 400, cors);

  await env.DB.prepare(
    'DELETE FROM user_rankings WHERE user_id = ? AND player_name = ?'
  ).bind(user.user_id, player_name).run();

  return json({ ok: true }, 200, cors);
}

async function handleAddPlayer(request, env, cors) {
  const user = await getAuthUser(request, env);
  if (!user) return err('Not authenticated', 401, cors);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON', 400, cors); }

  const { player_name, team, position, tier } = body ?? {};
  if (!player_name) return err('player_name required', 400, cors);
  const VALID_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);
  if (!VALID_POSITIONS.has(position)) return err('position must be QB, RB, WR, or TE', 400, cors);
  if (!Number.isInteger(tier) || tier < 1) return err('tier must be a positive integer', 400, cors);

  await env.DB.prepare(
    'INSERT OR REPLACE INTO user_rankings (user_id, player_name, team, position, tier, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(user.user_id, player_name.trim(), (team || '').trim(), position, tier, Date.now()).run();

  return json({ ok: true }, 200, cors);
}

async function handlePatchPick(request, env, cors) {
  const user = await getAuthUser(request, env);
  if (!user) return err('Not authenticated', 401, cors);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON', 400, cors); }

  const { pick_name, tier } = body ?? {};
  if (!pick_name) return err('pick_name required', 400, cors);

  if (tier === null || tier === undefined) {
    await env.DB.prepare(
      'DELETE FROM user_tier_picks WHERE user_id = ? AND pick_name = ?'
    ).bind(user.user_id, pick_name).run();
  } else {
    if (!Number.isInteger(tier) || tier < 1) return err('tier must be a positive integer', 400, cors);
    await env.DB.prepare(
      'INSERT OR REPLACE INTO user_tier_picks (user_id, pick_name, tier, updated_at) VALUES (?, ?, ?, ?)'
    ).bind(user.user_id, pick_name, tier, Date.now()).run();
  }

  return json({ ok: true }, 200, cors);
}

// ── Main fetch handler ────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;
    const cors   = getCors(request);

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // Auth routes (shared-auth.js compatible)
    if (path === '/api/auth/me'       && method === 'GET')  return handleMe(request, env, cors);
    if (path === '/api/auth/login'    && method === 'POST') return handleLogin(request, env, cors);
    if (path === '/api/auth/logout'   && method === 'POST') return handleLogout(request, env, cors);
    if (path === '/api/auth/register' && method === 'POST') {
      return err('Account creation is available at helper.ffhistorian.com', 403, cors);
    }

    // Rankings routes
    if (path === '/api/myranks/data'       && method === 'GET')    return handleGetData(request, env, cors);
    if (path === '/api/myranks/import'     && method === 'POST')   return handleImport(request, env, cors);
    if (path === '/api/myranks/player'     && method === 'PATCH')  return handlePatchPlayer(request, env, cors);
    if (path === '/api/myranks/player'     && method === 'DELETE') return handleDeletePlayer(request, env, cors);
    if (path === '/api/myranks/add-player' && method === 'POST')   return handleAddPlayer(request, env, cors);
    if (path === '/api/myranks/pick'       && method === 'PATCH')  return handlePatchPick(request, env, cors);

    return new Response('Not found', { status: 404 });
  },
};
