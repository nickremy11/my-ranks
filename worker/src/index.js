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

// ── Named ranking sets ────────────────────────────────────────────────────────

async function handleListSets(request, env, cors) {
  const user = await getAuthUser(request, env);
  if (!user) return err('Not authenticated', 401, cors);

  const res = await env.DB.prepare(
    `SELECT s.id, s.name, s.created_at, s.updated_at, COUNT(p.player_name) AS player_count
     FROM named_ranking_sets s
     LEFT JOIN named_ranking_players p ON p.set_id = s.id
     WHERE s.owner_user_id = ?
     GROUP BY s.id
     ORDER BY s.updated_at DESC`
  ).bind(user.user_id).all();

  return json({ sets: res.results }, 200, cors);
}

async function handleCreateSet(request, env, cors) {
  const user = await getAuthUser(request, env);
  if (!user) return err('Not authenticated', 401, cors);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON', 400, cors); }

  const { name, players } = body ?? {};
  if (!name || typeof name !== 'string' || !name.trim()) return err('name required', 400, cors);
  if (!Array.isArray(players)) return err('players array required', 400, cors);

  const VALID_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);
  for (const p of players) {
    if (!p.player_name) return err('Each player needs player_name', 400, cors);
    if (!VALID_POSITIONS.has(p.position)) return err(`Invalid position: ${p.position}`, 400, cors);
    if (!Number.isInteger(p.tier) || p.tier < 1) return err('tier must be a positive integer', 400, cors);
  }

  const now = Date.now();
  const setResult = await env.DB.prepare(
    'INSERT INTO named_ranking_sets (owner_user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)'
  ).bind(user.user_id, name.trim(), now, now).run();

  const setId = setResult.meta.last_row_id;
  const CHUNK = 25;
  for (let i = 0; i < players.length; i += CHUNK) {
    const chunk = players.slice(i, i + CHUNK);
    await env.DB.batch(chunk.map(p =>
      env.DB.prepare(
        'INSERT INTO named_ranking_players (set_id, player_name, team, position, tier) VALUES (?, ?, ?, ?, ?)'
      ).bind(setId, p.player_name.trim(), (p.team || '').trim(), p.position, p.tier)
    ));
  }

  return json({ ok: true, id: setId }, 200, cors);
}

async function handleGetSetData(request, env, cors, setId) {
  const user = await getAuthUser(request, env);
  if (!user) return err('Not authenticated', 401, cors);

  const set = await env.DB.prepare(
    'SELECT id, name FROM named_ranking_sets WHERE id = ? AND owner_user_id = ?'
  ).bind(setId, user.user_id).first();
  if (!set) return err('Set not found', 404, cors);

  const res = await env.DB.prepare(
    'SELECT player_name, team, position, tier FROM named_ranking_players WHERE set_id = ? ORDER BY tier, position, player_name'
  ).bind(setId).all();

  return json({ id: set.id, name: set.name, rankings: res.results }, 200, cors);
}

async function handleOverwriteSet(request, env, cors, setId) {
  const user = await getAuthUser(request, env);
  if (!user) return err('Not authenticated', 401, cors);

  const set = await env.DB.prepare(
    'SELECT id FROM named_ranking_sets WHERE id = ? AND owner_user_id = ?'
  ).bind(setId, user.user_id).first();
  if (!set) return err('Set not found', 404, cors);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON', 400, cors); }

  const { players } = body ?? {};
  if (!Array.isArray(players)) return err('players array required', 400, cors);

  const VALID_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);
  for (const p of players) {
    if (!p.player_name) return err('Each player needs player_name', 400, cors);
    if (!VALID_POSITIONS.has(p.position)) return err(`Invalid position: ${p.position}`, 400, cors);
    if (!Number.isInteger(p.tier) || p.tier < 1) return err('tier must be a positive integer', 400, cors);
  }

  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM named_ranking_players WHERE set_id = ?').bind(setId),
    env.DB.prepare('UPDATE named_ranking_sets SET updated_at = ? WHERE id = ?').bind(now, setId),
  ]);

  const CHUNK = 25;
  for (let i = 0; i < players.length; i += CHUNK) {
    const chunk = players.slice(i, i + CHUNK);
    await env.DB.batch(chunk.map(p =>
      env.DB.prepare(
        'INSERT INTO named_ranking_players (set_id, player_name, team, position, tier) VALUES (?, ?, ?, ?, ?)'
      ).bind(setId, p.player_name.trim(), (p.team || '').trim(), p.position, p.tier)
    ));
  }

  return json({ ok: true }, 200, cors);
}

async function handleDeleteSet(request, env, cors, setId) {
  const user = await getAuthUser(request, env);
  if (!user) return err('Not authenticated', 401, cors);

  const set = await env.DB.prepare(
    'SELECT id FROM named_ranking_sets WHERE id = ? AND owner_user_id = ?'
  ).bind(setId, user.user_id).first();
  if (!set) return err('Set not found', 404, cors);

  await env.DB.batch([
    env.DB.prepare('DELETE FROM named_ranking_players WHERE set_id = ?').bind(setId),
    env.DB.prepare('DELETE FROM named_ranking_sets WHERE id = ?').bind(setId),
  ]);

  return json({ ok: true }, 200, cors);
}

// ── External data proxies (KV-cached, shared with sleeper-helper) ─────────────

const SLEEPER_PLAYERS_URL = 'https://api.sleeper.app/v1/players/nfl';
const FC_URL = 'https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=2&ppr=1&includePickValues=true';
const AGE_MAP_KEY = 'myranks_age_map';
const AGE_MAP_TTL = 60 * 60 * 24 * 7; // 7 days
const FC_KEY      = 'fc_values';
const FC_TTL      = 60 * 60 * 24;     // 24 hours

function decimalAge(birthDateStr) {
  if (!birthDateStr) return null;
  const birth = new Date(birthDateStr);
  if (isNaN(birth.getTime())) return null;
  const ageDays = (Date.now() - birth.getTime()) / (1000 * 60 * 60 * 24);
  return Math.floor(ageDays / 365.25 * 10) / 10;
}

async function handleGetPlayers(env, cors) {
  const cached = await env.SLEEPER_KV.get(AGE_MAP_KEY, 'text');
  if (cached) return jsonRes(cached, cors);

  const upstream = await fetch(SLEEPER_PLAYERS_URL, { headers: { 'User-Agent': 'myranks/1.0' } });
  if (!upstream.ok) return err('Sleeper upstream error', 502, cors);

  const players = await upstream.json();
  const ageMap = {};
  for (const p of Object.values(players)) {
    if (!p.full_name) continue;
    const age = decimalAge(p.birth_date) ?? (typeof p.age === 'number' ? p.age : null);
    if (age !== null) ageMap[p.full_name] = age;
  }

  const body = JSON.stringify(ageMap);
  await env.SLEEPER_KV.put(AGE_MAP_KEY, body, { expirationTtl: AGE_MAP_TTL });
  return jsonRes(body, cors);
}

async function handleGetFC(env, cors) {
  const cached = await env.SLEEPER_KV.get(FC_KEY, 'text');
  if (cached) return jsonRes(cached, cors);

  const upstream = await fetch(FC_URL, { headers: { 'User-Agent': 'myranks/1.0' } });
  if (!upstream.ok) return err('FantasyCalc upstream error', 502, cors);

  const body = await upstream.text();
  await env.SLEEPER_KV.put(FC_KEY, body, { expirationTtl: FC_TTL });
  return jsonRes(body, cors);
}

function jsonRes(body, cors) {
  return new Response(body, {
    headers: { ...cors, 'Content-Type': 'application/json;charset=UTF-8' },
  });
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
    if (path === '/api/myranks/players'    && method === 'GET')    return handleGetPlayers(env, cors);
    if (path === '/api/myranks/fc'         && method === 'GET')    return handleGetFC(env, cors);

    // Named sets routes
    if (path === '/api/myranks/sets' && method === 'GET')  return handleListSets(request, env, cors);
    if (path === '/api/myranks/sets' && method === 'POST') return handleCreateSet(request, env, cors);
    const setMatch = path.match(/^\/api\/myranks\/sets\/(\d+)(\/data)?$/);
    if (setMatch) {
      const setId = parseInt(setMatch[1], 10);
      if (setMatch[2] === '/data' && method === 'GET') return handleGetSetData(request, env, cors, setId);
      if (!setMatch[2] && method === 'PUT')            return handleOverwriteSet(request, env, cors, setId);
      if (!setMatch[2] && method === 'DELETE')         return handleDeleteSet(request, env, cors, setId);
    }

    return new Response('Not found', { status: 404 });
  },
};
