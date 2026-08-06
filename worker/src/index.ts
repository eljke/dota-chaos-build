import { generateBuild } from '../../js/generator.js';
import { BOOT_KEYS, isItemCompatible } from '../../js/item-rules.js';
import { calculateScore, verifyMatch } from './verify.js';

type JsonObject = Record<string, unknown>;
type RankedItem = { id: number; key: string; sourceKey: string; name: string; cost: number };
type RankedHero = { id: number; key: string; name: string; attack_type: string; roles: string[] };
type RankedPool = { generatedAt: string; heroes: RankedHero[]; items: RankedItem[] };
type UserRow = { steam_id: string; account_id: number; display_name: string };
type LoginCodeRow = { steam_id: string };
type AttemptRow = {
  id: string; steam_id: string; mode: 'normal' | 'turbo'; order_required: number;
  status: 'rolling' | 'committed' | 'verified' | 'expired'; roll_count: number; seed: string;
  hero_id: number; hero_key: string; hero_name: string; items_json: string; modifier_id: string | null;
  rules_version: string; data_version: string; created_at: number; updated_at: number; committed_at: number | null;
};

const STEAM_OPENID = 'https://steamcommunity.com/openid/login';
const STEAM_ID_BASE = 76561197960265728n;
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const ATTEMPT_SECONDS = 24 * 60 * 60;
const RULES_VERSION = '1.4.0';

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code = 'request_failed') {
    super(message);
  }
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRankedPool(value: unknown): value is RankedPool {
  if (!isRecord(value) || typeof value.generatedAt !== 'string' || !Array.isArray(value.heroes) || !Array.isArray(value.items)) return false;
  return value.heroes.every(hero => isRecord(hero) && Number.isInteger(hero.id) && typeof hero.key === 'string')
    && value.items.every(item => isRecord(item) && Number.isInteger(item.id) && typeof item.key === 'string' && typeof item.sourceKey === 'string');
}

async function readJson(request: Request): Promise<JsonObject> {
  const size = Number(request.headers.get('content-length') || 0);
  if (size > 16_384) throw new HttpError(413, 'Слишком большой запрос.', 'payload_too_large');
  const value: unknown = await request.json();
  if (!isRecord(value)) throw new HttpError(400, 'Ожидался JSON-объект.', 'invalid_json');
  return value;
}

function corsHeaders(env: Env): HeadersInit {
  return {
    'Access-Control-Allow-Origin': env.SITE_ORIGIN,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(data: unknown, status: number, env: Env): Response {
  return Response.json(data, { status, headers: corsHeaders(env) });
}

function randomToken(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function hashToken(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function safeReturnTo(value: string | null, env: Env): string {
  if (!value) return env.SITE_URL;
  try {
    const url = new URL(value);
    return url.origin === env.SITE_ORIGIN && url.pathname.startsWith('/dota-chaos-build') ? url.toString() : env.SITE_URL;
  } catch {
    return env.SITE_URL;
  }
}

async function getUser(request: Request, env: Env): Promise<UserRow | null> {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return null;
  const token = authorization.slice(7).trim();
  if (!token) return null;
  return env.DB.prepare(`
    SELECT users.steam_id, users.account_id, users.display_name
    FROM sessions JOIN users ON users.steam_id = sessions.steam_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).bind(await hashToken(token), nowSeconds()).first<UserRow>();
}

async function requireUser(request: Request, env: Env): Promise<UserRow> {
  const user = await getUser(request, env);
  if (!user) throw new HttpError(401, 'Войдите через Steam.', 'unauthorized');
  return user;
}

async function getPool(env: Env, ctx: ExecutionContext): Promise<RankedPool> {
  const url = new URL('data/ranked-pool.json', env.SITE_URL).toString();
  const cache = await caches.open('ranked-pool');
  const request = new Request(url);
  let response = await cache.match(request);
  if (!response) {
    response = await fetch(request);
    if (!response.ok) throw new HttpError(503, 'Ranked-пул пока не опубликован GitHub Pages.', 'pool_unavailable');
    const cached = new Response(response.body, response);
    cached.headers.set('Cache-Control', 'public, max-age=300');
    ctx.waitUntil(cache.put(request, cached.clone()));
    response = cached;
  }
  const value: unknown = await response.json();
  if (!isRankedPool(value)) throw new HttpError(503, 'Ranked-пул имеет неверный формат.', 'invalid_pool');
  return value;
}

function createRoll(pool: RankedPool, mode: 'normal' | 'turbo', orderRequired: boolean) {
  const seed = crypto.randomUUID();
  const itemsByKey = Object.fromEntries(pool.items.map(item => [item.key, item]));
  const build = generateBuild({
    seed,
    forceBootSlot: true,
    heroes: pool.heroes,
    itemPool: pool.items.filter(item => item.key !== 'rapier'),
    itemsByKey,
    bootKeys: BOOT_KEYS,
    isCompatible: isItemCompatible,
    modifierCount: 1,
    rapierChance: 0.0035
  });
  if (!build.hero || build.items.length !== 6) throw new HttpError(503, 'Недостаточно данных для ranked-сборки.', 'pool_incomplete');
  return { seed, mode, orderRequired, hero: build.hero, items: build.items };
}

function challenge(row: AttemptRow) {
  const items: RankedItem[] = JSON.parse(row.items_json);
  return {
    id: row.id,
    status: row.status,
    mode: row.mode,
    orderRequired: row.order_required === 1,
    rerolls: row.roll_count,
    rollsSeen: row.roll_count + 1,
    scorePreview: calculateScore({ rerolls: row.roll_count, orderRequired: row.order_required === 1 }),
    hero: { id: row.hero_id, key: row.hero_key, name: row.hero_name },
    items,
    rulesVersion: row.rules_version,
    dataVersion: row.data_version,
    committedAt: row.committed_at
  };
}

async function handleSteamLogin(url: URL, env: Env): Promise<Response> {
  const state = randomToken(24);
  const callback = new URL('/auth/steam/callback', url.origin);
  callback.searchParams.set('state', state);
  const expiresAt = nowSeconds() + 600;
  await env.DB.prepare('INSERT INTO oauth_states (state_hash, return_to, expires_at) VALUES (?, ?, ?)')
    .bind(await hashToken(state), safeReturnTo(url.searchParams.get('return_to'), env), expiresAt).run();

  const target = new URL(STEAM_OPENID);
  target.searchParams.set('openid.ns', 'http://specs.openid.net/auth/2.0');
  target.searchParams.set('openid.mode', 'checkid_setup');
  target.searchParams.set('openid.return_to', callback.toString());
  target.searchParams.set('openid.realm', url.origin);
  target.searchParams.set('openid.identity', 'http://specs.openid.net/auth/2.0/identifier_select');
  target.searchParams.set('openid.claimed_id', 'http://specs.openid.net/auth/2.0/identifier_select');
  return Response.redirect(target.toString(), 302);
}

async function handleSteamCallback(request: Request, url: URL, env: Env): Promise<Response> {
  const state = url.searchParams.get('state') || '';
  const stateRow = await env.DB.prepare('DELETE FROM oauth_states WHERE state_hash = ? AND expires_at > ? RETURNING return_to')
    .bind(await hashToken(state), nowSeconds()).first<{ return_to: string }>();
  if (!stateRow) throw new HttpError(400, 'Steam login устарел или уже использован.', 'invalid_state');

  const verification = new URLSearchParams();
  for (const [key, value] of url.searchParams) if (key.startsWith('openid.')) verification.set(key, value);
  verification.set('openid.mode', 'check_authentication');
  const steamResponse = await fetch(STEAM_OPENID, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: verification
  });
  const result = await steamResponse.text();
  if (!steamResponse.ok || !result.split(/\r?\n/).includes('is_valid:true')) {
    throw new HttpError(401, 'Steam не подтвердил вход.', 'steam_rejected');
  }

  const claimedId = url.searchParams.get('openid.claimed_id') || '';
  const steamId = claimedId.match(/\/openid\/id\/(\d+)$/)?.[1];
  if (!steamId) throw new HttpError(400, 'SteamID отсутствует в ответе.', 'missing_steam_id');
  const accountIdBig = BigInt(steamId) - STEAM_ID_BASE;
  if (accountIdBig < 0n || accountIdBig > 4_294_967_295n) throw new HttpError(400, 'Некорректный SteamID.', 'invalid_steam_id');

  const now = nowSeconds();
  const code = randomToken(24);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (steam_id, account_id, display_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(steam_id) DO UPDATE SET account_id = excluded.account_id, updated_at = excluded.updated_at`)
      .bind(steamId, Number(accountIdBig), `Steam ${steamId.slice(-6)}`, now, now),
    env.DB.prepare('INSERT INTO login_codes (code_hash, steam_id, expires_at) VALUES (?, ?, ?)')
      .bind(await hashToken(code), steamId, now + 300)
  ]);
  const returnUrl = new URL(stateRow.return_to);
  returnUrl.searchParams.set('steam_code', code);
  return Response.redirect(returnUrl.toString(), 302);
}

async function handleExchange(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const code = typeof body.code === 'string' ? body.code : '';
  const login = await env.DB.prepare('DELETE FROM login_codes WHERE code_hash = ? AND expires_at > ? RETURNING steam_id')
    .bind(await hashToken(code), nowSeconds()).first<LoginCodeRow>();
  if (!login) throw new HttpError(400, 'Код входа устарел или уже использован.', 'invalid_login_code');

  const token = randomToken();
  const now = nowSeconds();
  await env.DB.prepare('INSERT INTO sessions (token_hash, steam_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(await hashToken(token), login.steam_id, now + SESSION_SECONDS, now).run();
  const user = await env.DB.prepare('SELECT steam_id, account_id, display_name FROM users WHERE steam_id = ?')
    .bind(login.steam_id).first<UserRow>();
  return json({ token, user }, 200, env);
}

async function getAttempt(id: string, steamId: string, env: Env): Promise<AttemptRow> {
  const row = await env.DB.prepare('SELECT * FROM attempts WHERE id = ? AND steam_id = ?').bind(id, steamId).first<AttemptRow>();
  if (!row) throw new HttpError(404, 'Ranked-попытка не найдена.', 'attempt_not_found');
  return row;
}

async function handleCreateAttempt(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const mode = body.mode === 'turbo' ? 'turbo' : 'normal';
  const orderRequired = body.orderRequired === true;
  const now = nowSeconds();
  const active = await env.DB.prepare(`SELECT * FROM attempts
    WHERE steam_id = ? AND status IN ('rolling', 'committed') AND created_at > ? ORDER BY created_at DESC LIMIT 1`)
    .bind(user.steam_id, now - ATTEMPT_SECONDS).first<AttemptRow>();
  if (active) return json({ error: 'Сначала завершите текущую попытку.', code: 'active_attempt', attempt: challenge(active) }, 409, env);

  await env.DB.prepare(`UPDATE attempts SET status = 'expired', updated_at = ?
    WHERE steam_id = ? AND status IN ('rolling', 'committed')`).bind(now, user.steam_id).run();
  const pool = await getPool(env, ctx);
  const roll = createRoll(pool, mode, orderRequired);
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO attempts
    (id, steam_id, mode, order_required, status, roll_count, seed, hero_id, hero_key, hero_name, items_json,
     modifier_id, rules_version, data_version, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'rolling', 0, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`)
    .bind(id, user.steam_id, mode, orderRequired ? 1 : 0, roll.seed, roll.hero.id, roll.hero.key, roll.hero.name,
      JSON.stringify(roll.items), RULES_VERSION, pool.generatedAt, now, now).run();
  return json({ attempt: challenge(await getAttempt(id, user.steam_id, env)) }, 201, env);
}

async function handleReroll(id: string, request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const user = await requireUser(request, env);
  const current = await getAttempt(id, user.steam_id, env);
  if (current.status !== 'rolling') throw new HttpError(409, 'Зафиксированную сборку нельзя перебросить.', 'attempt_locked');
  const pool = await getPool(env, ctx);
  const roll = createRoll(pool, current.mode, current.order_required === 1);
  const result = await env.DB.prepare(`UPDATE attempts SET roll_count = roll_count + 1, seed = ?, hero_id = ?, hero_key = ?,
    hero_name = ?, items_json = ?, data_version = ?, updated_at = ? WHERE id = ? AND status = 'rolling' AND roll_count = ?`)
    .bind(roll.seed, roll.hero.id, roll.hero.key, roll.hero.name, JSON.stringify(roll.items), pool.generatedAt,
      nowSeconds(), id, current.roll_count).run();
  if (result.meta.changes !== 1) throw new HttpError(409, 'Сборка уже была изменена в другой вкладке.', 'reroll_conflict');
  return json({ attempt: challenge(await getAttempt(id, user.steam_id, env)) }, 200, env);
}

async function handleCommit(id: string, request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const now = nowSeconds();
  const result = await env.DB.prepare(`UPDATE attempts SET status = 'committed', committed_at = ?, updated_at = ?
    WHERE id = ? AND steam_id = ? AND status = 'rolling'`).bind(now, now, id, user.steam_id).run();
  if (result.meta.changes !== 1) throw new HttpError(409, 'Попытка уже зафиксирована или завершена.', 'commit_conflict');
  return json({ attempt: challenge(await getAttempt(id, user.steam_id, env)) }, 200, env);
}

async function handleSubmit(id: string, request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const attempt = await getAttempt(id, user.steam_id, env);
  if (attempt.status !== 'committed' || !attempt.committed_at) throw new HttpError(409, 'Сначала зафиксируйте сборку.', 'attempt_not_committed');
  const body = await readJson(request);
  const matchId = typeof body.matchId === 'string' ? body.matchId.trim() : String(body.matchId || '');
  if (!/^\d{8,12}$/.test(matchId)) throw new HttpError(400, 'Введите корректный match ID.', 'invalid_match_id');

  const response = await fetch(`${env.OPENDOTA_API}/matches/${matchId}`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new HttpError(response.status === 404 ? 404 : 502, 'OpenDota не вернула данные матча.', 'match_unavailable');
  const match: unknown = await response.json();
  if (!isRecord(match)) throw new HttpError(502, 'OpenDota вернула неверный ответ.', 'invalid_match');
  const proof = verifyMatch({
    match,
    attempt: { ...attempt, items: JSON.parse(attempt.items_json) },
    accountId: user.account_id
  });
  if (!proof.parsed) {
    await fetch(`${env.OPENDOTA_API}/request/${matchId}`, { method: 'POST', headers: { Accept: 'application/json' } });
    return json({ status: 'parsing', errors: proof.errors }, 202, env);
  }
  if (!proof.ok) return json({ status: 'rejected', errors: proof.errors }, 422, env);

  const score = calculateScore({ rerolls: attempt.roll_count, orderRequired: attempt.order_required === 1 });
  const now = nowSeconds();
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO submissions
        (id, attempt_id, steam_id, match_id, score, rerolls, order_required, mode, modifier_id, evidence_json, verified_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), attempt.id, user.steam_id, matchId, score, attempt.roll_count, attempt.order_required,
          attempt.mode, attempt.modifier_id, JSON.stringify(proof.evidence), now),
      env.DB.prepare("UPDATE attempts SET status = 'verified', updated_at = ? WHERE id = ? AND status = 'committed'")
        .bind(now, attempt.id),
      env.DB.prepare('UPDATE users SET display_name = ?, updated_at = ? WHERE steam_id = ?')
        .bind(typeof proof.player?.personaname === 'string' ? proof.player.personaname.slice(0, 80) : user.display_name, now, user.steam_id)
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
      throw new HttpError(409, 'Этот матч или попытка уже подтверждены.', 'duplicate_submission');
    }
    throw error;
  }
  return json({ status: 'verified', score, evidence: proof.evidence }, 200, env);
}

async function handleLeaderboard(url: URL, env: Env): Promise<Response> {
  const mode = url.searchParams.get('mode') === 'turbo' ? 'turbo' : 'normal';
  const { results } = await env.DB.prepare(`
    WITH ranked AS (
      SELECT submissions.*, ROW_NUMBER() OVER (PARTITION BY steam_id ORDER BY score DESC, verified_at ASC) AS run_rank
      FROM submissions WHERE mode = ?
    )
    SELECT users.steam_id AS steamId, users.display_name AS displayName,
      SUM(ranked.score) AS score, COUNT(*) AS verifiedWins,
      SUM(ranked.rerolls) AS rerolls, SUM(ranked.order_required) AS orderedWins
    FROM ranked JOIN users ON users.steam_id = ranked.steam_id
    WHERE ranked.run_rank <= 10
    GROUP BY ranked.steam_id
    ORDER BY score DESC, rerolls ASC, MIN(ranked.verified_at) ASC
    LIMIT 50
  `).bind(mode).all();
  return json({ mode, entries: results }, 200, env);
}

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env) });
  if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true, rulesVersion: RULES_VERSION }, 200, env);
  if (request.method === 'GET' && url.pathname === '/auth/steam') return handleSteamLogin(url, env);
  if (request.method === 'GET' && url.pathname === '/auth/steam/callback') return handleSteamCallback(request, url, env);
  if (request.method === 'POST' && url.pathname === '/auth/exchange') return handleExchange(request, env);
  if (request.method === 'GET' && url.pathname === '/me') return json({ user: await getUser(request, env) }, 200, env);
  if (request.method === 'GET' && url.pathname === '/leaderboard') return handleLeaderboard(url, env);
  if (request.method === 'GET' && url.pathname === '/attempts/active') {
    const user = await requireUser(request, env);
    const active = await env.DB.prepare(`SELECT * FROM attempts WHERE steam_id = ? AND status IN ('rolling', 'committed')
      AND created_at > ? ORDER BY created_at DESC LIMIT 1`).bind(user.steam_id, nowSeconds() - ATTEMPT_SECONDS).first<AttemptRow>();
    return json({ attempt: active ? challenge(active) : null }, 200, env);
  }
  if (request.method === 'POST' && url.pathname === '/attempts') return handleCreateAttempt(request, env, ctx);

  const match = url.pathname.match(/^\/attempts\/([0-9a-f-]+)\/(reroll|commit|submit)$/i);
  if (request.method === 'POST' && match) {
    if (match[2] === 'reroll') return handleReroll(match[1], request, env, ctx);
    if (match[2] === 'commit') return handleCommit(match[1], request, env);
    return handleSubmit(match[1], request, env);
  }
  throw new HttpError(404, 'Маршрут не найден.', 'not_found');
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await handleRequest(request, env, ctx);
    } catch (error) {
      const known = error instanceof HttpError;
      const message = known ? error.message : 'Внутренняя ошибка сервера.';
      console.error(JSON.stringify({
        message: 'request failed',
        method: request.method,
        path: new URL(request.url).pathname,
        error: error instanceof Error ? error.message : String(error)
      }));
      return json({ error: message, code: known ? error.code : 'internal_error' }, known ? error.status : 500, env);
    }
  }
} satisfies ExportedHandler<Env>;
