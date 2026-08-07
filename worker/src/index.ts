import { generateBuild, seededRandom } from '../../js/generator.js';
import { BOOT_KEYS, isItemCompatible } from '../../js/item-rules.js';
import { eligibleModifiers, modifierById } from '../../js/modifiers.js';
import { calculateScore, verifyMatch } from './verify.js';
import { normalizeStratzMatch, openDotaRateLimit } from './providers.js';

type JsonObject = Record<string, unknown>;
type RankedItem = { id: number; key: string; sourceKey: string; name: string; cost: number };
type RankedHero = { id: number; key: string; name: string; attack_type: string; roles: string[] };
type RankedPool = { generatedAt: string; heroes: RankedHero[]; items: RankedItem[] };
type UserRow = { steam_id: string; account_id: number; display_name: string; avatar_url: string };
type LoginCodeRow = { steam_id: string };
type PenaltyRow = { cancel_penalties: number; cooldown_until: number };
type MatchCacheRow = { match_json: string; source: string; parsed: number; expires_at: number };
type ProviderStateRow = { blocked_until: number; reason: string };
type MatchFetchResult = { match: JsonObject | null; status: 'ready' | 'parsing' | 'waiting_provider'; message: string; retryAfter: number; source?: string };
type AttemptRow = {
  id: string; steam_id: string; mode: 'normal' | 'turbo'; order_required: number;
  status: 'rolling' | 'committed' | 'verified' | 'expired'; roll_count: number; seed: string;
  hero_id: number; hero_key: string; hero_name: string; items_json: string; modifier_id: string | null;
  rules_version: string; data_version: string; created_at: number; updated_at: number; committed_at: number | null;
  cancel_penalties: number; verification_retry_at: number;
};

const STEAM_OPENID = 'https://steamcommunity.com/openid/login';
const STEAM_PLAYER_SUMMARIES = 'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/';
const STEAM_ID_BASE = 76561197960265728n;
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const ATTEMPT_SECONDS = 24 * 60 * 60;
const CANCEL_COOLDOWN_SECONDS = 60;
const CANCEL_PENALTY_ROLLS = 1;
const MATCH_GUARD_SECONDS = { normal: 60, turbo: 60 } as const;
const MATCH_CACHE_SECONDS = 7 * 24 * 60 * 60;
const UNPARSED_CACHE_SECONDS = 45;
const PARSE_REQUEST_COOLDOWN_SECONDS = 5 * 60;
const VERIFICATION_REQUEST_COOLDOWN_SECONDS = 15;
const STRATZ_API = 'https://api.stratz.com/graphql';
const RULES_VERSION = '1.6.1';

class HttpError extends Error {
  constructor(
      readonly status: number,
      message: string,
      readonly code = 'request_failed',
      readonly details: JsonObject = {}
  ) {
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


function cleanProfileText(value: unknown, fallback: string): string {
  const normalized = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return normalized ? normalized.slice(0, 80) : fallback;
}

async function fetchSteamProfile(steamId: string, env: Env): Promise<{ displayName: string; avatarUrl: string }> {
  const fallback = { displayName: `Игрок ${steamId.slice(-6)}`, avatarUrl: '' };
  const apiKey = String((env as Env & { STEAM_API_KEY?: string }).STEAM_API_KEY || '').trim();

  if (apiKey) {
    try {
      const url = new URL(STEAM_PLAYER_SUMMARIES);
      url.searchParams.set('key', apiKey);
      url.searchParams.set('steamids', steamId);
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      const body: unknown = response.ok ? await response.json() : null;
      const player = isRecord(body) && isRecord(body.response) && Array.isArray(body.response.players)
          ? body.response.players[0]
          : null;
      if (isRecord(player)) {
        return {
          displayName: cleanProfileText(player.personaname, fallback.displayName),
          avatarUrl: typeof player.avatarfull === 'string' && /^https:\/\//i.test(player.avatarfull) ? player.avatarfull : ''
        };
      }
    } catch (error) {
      console.warn('Steam Web API profile lookup failed:', error);
    }
  }

  try {
    const response = await fetch(`https://steamcommunity.com/profiles/${steamId}?xml=1`, { headers: { Accept: 'application/xml' } });
    const xml = response.ok ? await response.text() : '';
    const displayName = xml.match(/<steamID><!\[CDATA\[([\s\S]*?)\]\]><\/steamID>/)?.[1];
    const avatarUrl = xml.match(/<avatarFull><!\[CDATA\[([\s\S]*?)\]\]><\/avatarFull>/)?.[1];
    return {
      displayName: cleanProfileText(displayName, fallback.displayName),
      avatarUrl: avatarUrl && /^https:\/\//i.test(avatarUrl) ? avatarUrl : ''
    };
  } catch {
    return fallback;
  }
}

async function getUser(request: Request, env: Env): Promise<UserRow | null> {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return null;
  const token = authorization.slice(7).trim();
  if (!token) return null;
  return env.DB.prepare(`
    SELECT users.steam_id, users.account_id, users.display_name, users.avatar_url
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
  const modifiers = eligibleModifiers({ hero: build.hero, items: build.items });
  const modifier = modifiers[Math.floor(seededRandom(`modifier:${seed}`)() * modifiers.length)];
  return { seed, mode, orderRequired, hero: build.hero, items: build.items, modifier };
}

function challenge(row: AttemptRow) {
  const items: RankedItem[] = JSON.parse(row.items_json);
  const modifier = modifierById(row.modifier_id);
  const cancelPenalties = Number(row.cancel_penalties || 0);
  const committedAt = Number(row.committed_at || row.updated_at);
  const matchGuardSeconds = MATCH_GUARD_SECONDS[row.mode];
  return {
    id: row.id,
    status: row.status,
    mode: row.mode,
    orderRequired: row.order_required === 1,
    rerolls: row.roll_count,
    cancelPenalties,
    totalPenalties: row.roll_count + cancelPenalties,
    rollsSeen: row.roll_count + 1,
    scorePreview: calculateScore({
      rerolls: row.roll_count,
      cancelPenalties,
      orderRequired: row.order_required === 1,
      modifierMultiplier: modifier?.multiplier
    }),
    hero: { id: row.hero_id, key: row.hero_key, name: row.hero_name },
    items,
    modifier,
    rulesVersion: row.rules_version,
    dataVersion: row.data_version,
    committedAt,
    eligibleAt: committedAt + matchGuardSeconds,
    expiresAt: row.created_at + ATTEMPT_SECONDS,
    matchGuardSeconds,
    cancelCost: CANCEL_PENALTY_ROLLS,
    verificationRetryAt: Number(row.verification_retry_at || 0)
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
  const profile = await fetchSteamProfile(steamId, env);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (steam_id, account_id, display_name, avatar_url, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(steam_id) DO UPDATE SET account_id = excluded.account_id,
                                                                                  display_name = excluded.display_name, avatar_url = excluded.avatar_url, updated_at = excluded.updated_at`)
        .bind(steamId, Number(accountIdBig), profile.displayName, profile.avatarUrl, now, now),
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
  const user = await env.DB.prepare('SELECT steam_id, account_id, display_name, avatar_url FROM users WHERE steam_id = ?')
      .bind(login.steam_id).first<UserRow>();
  return json({ token, user }, 200, env);
}

async function getAttempt(id: string, steamId: string, env: Env): Promise<AttemptRow> {
  const row = await env.DB.prepare('SELECT * FROM attempts WHERE id = ? AND steam_id = ?').bind(id, steamId).first<AttemptRow>();
  if (!row) throw new HttpError(404, 'Ranked-попытка не найдена.', 'attempt_not_found');
  return row;
}


async function getPenalty(steamId: string, mode: 'normal' | 'turbo', env: Env): Promise<PenaltyRow> {
  return await env.DB.prepare('SELECT cancel_penalties, cooldown_until FROM ranked_penalties WHERE steam_id = ? AND mode = ?')
      .bind(steamId, mode).first<PenaltyRow>() || { cancel_penalties: 0, cooldown_until: 0 };
}

function isParsedMatch(match: JsonObject): boolean {
  if (isRecord(match.od_data) && match.od_data.has_parsed === true) return true;
  return Array.isArray(match.players) && match.players.some(player => isRecord(player) && Array.isArray(player.purchase_log));
}

async function getCachedMatch(matchId: string, env: Env): Promise<{ match: JsonObject; source: string; parsed: boolean } | null> {
  const row = await env.DB.prepare(`SELECT match_json, source, parsed, expires_at FROM match_cache
                                    WHERE match_id = ? AND expires_at > ?`).bind(matchId, nowSeconds()).first<MatchCacheRow>();
  if (!row) return null;
  try {
    const match: unknown = JSON.parse(row.match_json);
    return isRecord(match) ? { match, source: row.source, parsed: row.parsed === 1 } : null;
  } catch {
    return null;
  }
}

async function cacheMatch(matchId: string, source: string, match: JsonObject, parsed: boolean, env: Env): Promise<void> {
  const now = nowSeconds();
  const ttl = parsed ? MATCH_CACHE_SECONDS : UNPARSED_CACHE_SECONDS;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO match_cache (match_id, source, match_json, parsed, fetched_at, expires_at)
                    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(match_id) DO UPDATE SET source = excluded.source,
                                                                                  match_json = excluded.match_json, parsed = excluded.parsed, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`)
        .bind(matchId, source, JSON.stringify(match), parsed ? 1 : 0, now, now + ttl),
    env.DB.prepare('DELETE FROM match_cache WHERE expires_at <= ?').bind(now),
    env.DB.prepare('DELETE FROM match_requests WHERE updated_at <= ?').bind(now - MATCH_CACHE_SECONDS)
  ]);
}

async function getProviderState(provider: string, env: Env): Promise<ProviderStateRow | null> {
  return env.DB.prepare('SELECT blocked_until, reason FROM provider_state WHERE provider = ? AND blocked_until > ?')
      .bind(provider, nowSeconds()).first<ProviderStateRow>();
}

async function blockProvider(provider: string, blockedUntil: number, reason: string, env: Env): Promise<void> {
  await env.DB.prepare(`INSERT INTO provider_state (provider, blocked_until, reason, updated_at) VALUES (?, ?, ?, ?)
                        ON CONFLICT(provider) DO UPDATE SET blocked_until = MAX(provider_state.blocked_until, excluded.blocked_until),
                                                            reason = excluded.reason, updated_at = excluded.updated_at`)
      .bind(provider, blockedUntil, reason, nowSeconds()).run();
}

async function claimVerificationRequest(attemptId: string, steamId: string, env: Env): Promise<void> {
  const now = nowSeconds();
  const retryAt = now + VERIFICATION_REQUEST_COOLDOWN_SECONDS;
  const claimed = await env.DB.prepare(`UPDATE attempts SET verification_retry_at = ?
                                        WHERE id = ? AND steam_id = ? AND status = 'committed' AND verification_retry_at <= ?`)
      .bind(retryAt, attemptId, steamId, now).run();
  if (claimed.meta.changes === 1) return;

  const row = await env.DB.prepare('SELECT verification_retry_at FROM attempts WHERE id = ? AND steam_id = ?')
      .bind(attemptId, steamId).first<{ verification_retry_at: number }>();
  const retryAfter = Math.max(1, Number(row?.verification_retry_at || retryAt) - now);
  throw new HttpError(429, `Повторная проверка будет доступна через ${retryAfter} сек.`, 'verification_cooldown', { retryAfter });
}

async function setVerificationCooldown(attemptId: string, seconds: number, env: Env): Promise<void> {
  const bounded = Math.max(1, Math.min(24 * 60 * 60, Math.ceil(Number(seconds) || VERIFICATION_REQUEST_COOLDOWN_SECONDS)));
  await env.DB.prepare(`UPDATE attempts SET verification_retry_at = MAX(verification_retry_at, ?)
                        WHERE id = ? AND status = 'committed'`)
      .bind(nowSeconds() + bounded, attemptId).run();
}

async function claimParseRequest(matchId: string, env: Env): Promise<boolean> {
  const now = nowSeconds();
  const claimed = await env.DB.prepare(`INSERT INTO match_requests (match_id, parse_requested_at, updated_at)
                                        VALUES (?, ?, ?) ON CONFLICT(match_id) DO UPDATE SET parse_requested_at = excluded.parse_requested_at,
                                                                                             updated_at = excluded.updated_at WHERE match_requests.parse_requested_at <= ? RETURNING match_id`)
      .bind(matchId, now, now, now - PARSE_REQUEST_COOLDOWN_SECONDS).first<{ match_id: string }>();
  return Boolean(claimed);
}

async function requestOpenDotaParse(matchId: string, env: Env): Promise<{ requested: boolean; retryAfter: number }> {
  const claimed = await claimParseRequest(matchId, env);
  if (!claimed) return { requested: false, retryAfter: 60 };

  let response: Response;
  try {
    response = await fetch(`${env.OPENDOTA_API}/request/${matchId}`, { method: 'POST', headers: { Accept: 'application/json' } });
  } catch {
    return { requested: false, retryAfter: 90 };
  }
  if (response.status === 429) {
    const upstreamBody = await response.text().catch(() => '');
    const limit = openDotaRateLimit(upstreamBody, { retryAfter: response.headers.get('retry-after') }, nowSeconds());
    await blockProvider('opendota', limit.blockedUntil, limit.kind, env);
    console.warn('OpenDota parse rate limit:', {
      body: upstreamBody,
      remainingMinute: response.headers.get('x-rate-limit-remaining-minute'),
      remainingDay: response.headers.get('x-rate-limit-remaining-day'),
      upstreamIp: response.headers.get('x-ip-address'),
      retryAfter: limit.retryAfter
    });
    return { requested: false, retryAfter: limit.retryAfter };
  }
  if (!response.ok && response.status !== 409) return { requested: false, retryAfter: 90 };
  return { requested: true, retryAfter: 60 };
}

const STRATZ_MATCH_QUERY = `
  query RankedMatch($id: Long!) {
    match(id: $id) {
      id didRadiantWin durationSeconds startDateTime lobbyType gameMode radiantKills direKills
      playbackData { runeEvents { fromPlayer } }
      players {
        steamAccountId playerSlot isVictory heroId kills deaths assists leaverStatus towerDamage
        item0Id item1Id item2Id item3Id item4Id item5Id backpack0Id backpack1Id backpack2Id
        stats {
          itemPurchases { itemId time }
          itemUsed { itemId count }
          wards { type }
          campStack
        }
        playbackData { buyBackEvents { time } }
      }
    }
  }
`;

async function fetchStratzMatch(matchId: string, env: Env): Promise<JsonObject | null> {
  const token = String((env as Env & { STRATZ_API_TOKEN?: string }).STRATZ_API_TOKEN || '').trim();
  if (!token) return null;

  let response: Response;
  try {
    response = await fetch(STRATZ_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/graphql-response+json, application/json'
      },
      body: JSON.stringify({ query: STRATZ_MATCH_QUERY, variables: { id: Number(matchId) } })
    });
  } catch (error) {
    console.warn('STRATZ request failed:', error);
    return null;
  }
  if (!response.ok) {
    console.warn('STRATZ returned non-OK:', response.status, await response.text().catch(() => ''));
    return null;
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload)) return null;
  if (Array.isArray(payload.errors) && payload.errors.length) {
    console.warn('STRATZ GraphQL errors:', JSON.stringify(payload.errors).slice(0, 1000));
  }
  const normalized: unknown = normalizeStratzMatch(payload);
  return isRecord(normalized) ? normalized : null;
}

async function fetchOpenDotaMatch(matchId: string, env: Env): Promise<JsonObject | null> {
  const blocked = await getProviderState('opendota', env);
  if (blocked) {
    throw new HttpError(429, 'OpenDota временно пропускается после ограничения запросов.', 'opendota_rate_limited', {
      retryAfter: Math.max(1, blocked.blocked_until - nowSeconds()), reason: blocked.reason
    });
  }

  let response: Response;
  try {
    response = await fetch(`${env.OPENDOTA_API}/matches/${matchId}`, { headers: { Accept: 'application/json' } });
  } catch {
    throw new HttpError(502, 'OpenDota сейчас недоступна.', 'opendota_unreachable');
  }
  if (response.status === 404) return null;
  if (response.status === 429) {
    const upstreamBody = await response.text().catch(() => '');
    const limit = openDotaRateLimit(upstreamBody, { retryAfter: response.headers.get('retry-after') }, nowSeconds());
    await blockProvider('opendota', limit.blockedUntil, limit.kind, env);
    console.warn('OpenDota rate limit:', {
      endpoint: response.url,
      body: upstreamBody,
      remainingMinute: response.headers.get('x-rate-limit-remaining-minute'),
      remainingDay: response.headers.get('x-rate-limit-remaining-day'),
      upstreamIp: response.headers.get('x-ip-address'),
      retryAfter: limit.retryAfter
    });
    throw new HttpError(429, limit.message, 'opendota_rate_limited', { retryAfter: limit.retryAfter, reason: limit.kind });
  }
  if (!response.ok) throw new HttpError(502, 'OpenDota временно не вернула данные матча.', 'match_unavailable');
  const match: unknown = await response.json().catch(() => null);
  if (!isRecord(match)) throw new HttpError(502, 'OpenDota вернула неверный ответ.', 'invalid_match');
  return match;
}

async function fetchRankedMatch(matchId: string, env: Env): Promise<MatchFetchResult> {
  const cached = await getCachedMatch(matchId, env);
  if (cached) {
    return {
      match: cached.match,
      status: 'ready',
      message: cached.parsed ? 'Матч загружен из серверного кэша.' : 'Основные данные матча загружены из серверного кэша.',
      retryAfter: 0,
      source: cached.source
    };
  }

  let openDotaError: HttpError | null = null;
  try {
    const match = await fetchOpenDotaMatch(matchId, env);
    if (match) {
      const parsed = isParsedMatch(match);
      await cacheMatch(matchId, 'opendota', match, parsed, env);
      return {
        match,
        status: 'ready',
        message: parsed ? 'Матч получен из OpenDota.' : 'OpenDota вернула основные данные матча.',
        retryAfter: 0,
        source: 'opendota'
      };
    }
  } catch (error) {
    if (error instanceof HttpError && ['opendota_rate_limited', 'opendota_unreachable', 'match_unavailable'].includes(error.code)) {
      openDotaError = error;
    } else {
      throw error;
    }
  }

  const stratzMatch = await fetchStratzMatch(matchId, env);
  if (stratzMatch) {
    const parsed = isParsedMatch(stratzMatch);
    await cacheMatch(matchId, 'stratz', stratzMatch, parsed, env);
    return {
      match: stratzMatch,
      status: 'ready',
      message: openDotaError
          ? 'OpenDota недоступна — матч получен через бесплатный резерв STRATZ.'
          : 'Матч найден через бесплатный резерв STRATZ.',
      retryAfter: 0,
      source: 'stratz'
    };
  }

  if (!openDotaError) {
    const parse = await requestOpenDotaParse(matchId, env);
    return {
      match: null,
      status: 'parsing',
      message: parse.requested
          ? 'Матч один раз отправлен на разбор OpenDota. Повторный запрос временно заблокирован, чтобы не тратить лимит.'
          : 'Матч уже ожидает разбора OpenDota. Повторите проверку позже.',
      retryAfter: parse.retryAfter
    };
  }

  const hasStratz = Boolean((env as Env & { STRATZ_API_TOKEN?: string }).STRATZ_API_TOKEN);
  const retryAfter = hasStratz ? 60 : Number(openDotaError.details.retryAfter || 90);
  return {
    match: null,
    status: 'waiting_provider',
    message: hasStratz
        ? 'OpenDota ограничила запросы, а STRATZ пока не вернула матч. Попытка сохранена.'
        : 'OpenDota ограничила запросы. Попытка сохранена; можно повторить позже или подключить бесплатный STRATZ token.',
    retryAfter
  };
}

async function handleCreateAttempt(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const mode = body.mode === 'turbo' ? 'turbo' : 'normal';
  const orderRequired = body.orderRequired === true;
  const now = nowSeconds();
  let active = await env.DB.prepare(`SELECT * FROM attempts
                                     WHERE steam_id = ? AND status IN ('rolling', 'committed') AND created_at > ? ORDER BY created_at DESC LIMIT 1`)
      .bind(user.steam_id, now - ATTEMPT_SECONDS).first<AttemptRow>();
  if (active?.status === 'rolling') {
    await env.DB.prepare("UPDATE attempts SET status = 'committed', committed_at = ?, updated_at = ? WHERE id = ? AND status = 'rolling'")
        .bind(now, now, active.id).run();
    active = await getAttempt(active.id, user.steam_id, env);
  }
  if (active) return json({ error: 'Сначала завершите или отмените текущую попытку.', code: 'active_attempt', attempt: challenge(active) }, 409, env);

  const penalty = await getPenalty(user.steam_id, mode, env);
  if (penalty.cooldown_until > now) {
    const retryAfter = penalty.cooldown_until - now;
    throw new HttpError(429, `После отмены новая попытка будет доступна через ${retryAfter} сек.`, 'cancel_cooldown', { retryAfter });
  }

  await env.DB.prepare(`UPDATE attempts SET status = 'expired', updated_at = ?
    WHERE steam_id = ? AND status IN ('rolling', 'committed')`).bind(now, user.steam_id).run();
  const pool = await getPool(env, ctx);
  const roll = createRoll(pool, mode, orderRequired);
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO attempts
    (id, steam_id, mode, order_required, status, roll_count, cancel_penalties, seed, hero_id, hero_key, hero_name, items_json,
     modifier_id, rules_version, data_version, created_at, updated_at, committed_at)
    VALUES (?, ?, ?, ?, 'committed', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, user.steam_id, mode, orderRequired ? 1 : 0, penalty.cancel_penalties, roll.seed, roll.hero.id, roll.hero.key, roll.hero.name,
          JSON.stringify(roll.items), roll.modifier.id, RULES_VERSION, pool.generatedAt, now, now, now).run();
  return json({ attempt: challenge(await getAttempt(id, user.steam_id, env)) }, 201, env);
}

async function handleReroll(id: string, request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const user = await requireUser(request, env);
  const current = await getAttempt(id, user.steam_id, env);
  if (current.status !== 'committed') throw new HttpError(409, 'Эту попытку уже нельзя перебросить.', 'attempt_locked');
  const pool = await getPool(env, ctx);
  const roll = createRoll(pool, current.mode, current.order_required === 1);
  const now = nowSeconds();
  const result = await env.DB.prepare(`UPDATE attempts SET roll_count = roll_count + 1, seed = ?, hero_id = ?, hero_key = ?,
    hero_name = ?, items_json = ?, modifier_id = ?, rules_version = ?, data_version = ?, committed_at = ?, verification_retry_at = 0, updated_at = ?
    WHERE id = ? AND status = 'committed' AND roll_count = ?`)
      .bind(roll.seed, roll.hero.id, roll.hero.key, roll.hero.name, JSON.stringify(roll.items), roll.modifier.id, RULES_VERSION, pool.generatedAt,
          now, now, id, current.roll_count).run();
  if (result.meta.changes !== 1) throw new HttpError(409, 'Сборка уже была изменена в другой вкладке.', 'reroll_conflict');
  return json({ attempt: challenge(await getAttempt(id, user.steam_id, env)) }, 200, env);
}

async function handleCommit(id: string, request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const current = await getAttempt(id, user.steam_id, env);
  if (current.status === 'committed') return json({ attempt: challenge(current) }, 200, env);
  if (current.status !== 'rolling') throw new HttpError(409, 'Попытка уже завершена.', 'commit_conflict');
  const now = nowSeconds();
  await env.DB.prepare(`UPDATE attempts SET status = 'committed', committed_at = ?, updated_at = ?
    WHERE id = ? AND steam_id = ? AND status = 'rolling'`).bind(now, now, id, user.steam_id).run();
  return json({ attempt: challenge(await getAttempt(id, user.steam_id, env)) }, 200, env);
}

async function handleCancel(id: string, request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const current = await getAttempt(id, user.steam_id, env);
  if (!['rolling', 'committed'].includes(current.status)) throw new HttpError(409, 'Попытка уже завершена.', 'cancel_conflict');
  const now = nowSeconds();
  const cooldownUntil = now + CANCEL_COOLDOWN_SECONDS;
  const cancelled = await env.DB.prepare(`UPDATE attempts SET status = 'expired', updated_at = ?
    WHERE id = ? AND steam_id = ? AND status IN ('rolling', 'committed') RETURNING mode`)
      .bind(now, id, user.steam_id).first<{ mode: 'normal' | 'turbo' }>();
  if (!cancelled) throw new HttpError(409, 'Попытка уже изменилась в другой вкладке.', 'cancel_conflict');
  await env.DB.prepare(`INSERT INTO ranked_penalties (steam_id, mode, cancel_penalties, cooldown_until, updated_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(steam_id, mode) DO UPDATE SET
    cancel_penalties = ranked_penalties.cancel_penalties + excluded.cancel_penalties,
    cooldown_until = MAX(ranked_penalties.cooldown_until, excluded.cooldown_until), updated_at = excluded.updated_at`)
      .bind(user.steam_id, cancelled.mode, CANCEL_PENALTY_ROLLS, cooldownUntil, now).run();
  const penalty = await getPenalty(user.steam_id, current.mode, env);
  return json({ status: 'cancelled', cancelPenalties: penalty.cancel_penalties, cooldownUntil }, 200, env);
}

async function handleSubmit(id: string, request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const attempt = await getAttempt(id, user.steam_id, env);
  if (attempt.status !== 'committed' || !attempt.committed_at) throw new HttpError(409, 'Ranked-попытка не активна.', 'attempt_not_committed');
  const body = await readJson(request);
  const matchId = typeof body.matchId === 'string' ? body.matchId.trim() : String(body.matchId || '');
  if (!/^\d{8,12}$/.test(matchId)) throw new HttpError(400, 'Введите корректный match ID.', 'invalid_match_id');

  await claimVerificationRequest(attempt.id, user.steam_id, env);

  let fetched = await fetchRankedMatch(matchId, env);
  if (!fetched.match) {
    await setVerificationCooldown(attempt.id, fetched.retryAfter, env);
    return json({ status: fetched.status, message: fetched.message, retryAfter: fetched.retryAfter }, 202, env);
  }

  const verificationAttempt = {
    ...attempt,
    items: JSON.parse(attempt.items_json),
    match_guard_seconds: MATCH_GUARD_SECONDS[attempt.mode]
  };
  let proof = verifyMatch({ match: fetched.match, attempt: verificationAttempt, accountId: user.account_id });

  // OpenDota often exposes the result immediately but adds purchase history later.
  // Only ask STRATZ for the heavier parsed payload after the basic hero/win/time checks pass.
  if (!proof.parsed && fetched.source !== 'stratz') {
    const stratzMatch = await fetchStratzMatch(matchId, env);
    if (stratzMatch) {
      const parsed = isParsedMatch(stratzMatch);
      await cacheMatch(matchId, 'stratz', stratzMatch, parsed, env);
      if (parsed) {
        fetched = { match: stratzMatch, status: 'ready', message: 'Матч дополнен через STRATZ.', retryAfter: 0, source: 'stratz' };
        proof = verifyMatch({ match: stratzMatch, attempt: verificationAttempt, accountId: user.account_id });
      }
    }
  }

  if (!proof.parsed) {
    const parse = await requestOpenDotaParse(matchId, env);
    await setVerificationCooldown(attempt.id, parse.retryAfter, env);
    return json({
      status: 'parsing',
      message: 'Основные данные матча подтверждены, но журнал покупок ещё обрабатывается.',
      retryAfter: parse.retryAfter,
      errors: proof.errors
    }, 202, env);
  }
  if (!proof.ok) {
    await setVerificationCooldown(attempt.id, VERIFICATION_REQUEST_COOLDOWN_SECONDS, env);
    return json({
      error: proof.errors.join(' '), code: 'verification_failed', status: 'rejected', errors: proof.errors,
      retryAfter: VERIFICATION_REQUEST_COOLDOWN_SECONDS
    }, 422, env);
  }

  const modifier = modifierById(attempt.modifier_id);
  const cancelPenalties = Number(attempt.cancel_penalties || 0);
  const score = calculateScore({
    rerolls: attempt.roll_count,
    cancelPenalties,
    orderRequired: attempt.order_required === 1,
    modifierMultiplier: modifier?.multiplier
  });
  const now = nowSeconds();
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO submissions
        (id, attempt_id, steam_id, match_id, score, rerolls, cancel_penalties, order_required, mode, modifier_id, evidence_json, verified_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(crypto.randomUUID(), attempt.id, user.steam_id, matchId, score, attempt.roll_count, cancelPenalties, attempt.order_required,
              attempt.mode, attempt.modifier_id, JSON.stringify({ ...proof.evidence, source: fetched.source || 'unknown' }), now),
      env.DB.prepare("UPDATE attempts SET status = 'verified', updated_at = ? WHERE id = ? AND status = 'committed'")
          .bind(now, attempt.id),
      env.DB.prepare(`INSERT INTO ranked_penalties (steam_id, mode, cancel_penalties, cooldown_until, updated_at)
        VALUES (?, ?, 0, 0, ?) ON CONFLICT(steam_id, mode) DO UPDATE SET cancel_penalties = 0, cooldown_until = 0, updated_at = excluded.updated_at`)
          .bind(user.steam_id, attempt.mode, now)
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
      throw new HttpError(409, 'Этот матч или попытка уже подтверждены.', 'duplicate_submission');
    }
    throw error;
  }
  return json({ status: 'verified', score, source: fetched.source, evidence: proof.evidence }, 200, env);
}

async function handleLeaderboard(url: URL, env: Env): Promise<Response> {
  const mode = url.searchParams.get('mode') === 'turbo' ? 'turbo' : 'normal';
  const { results } = await env.DB.prepare(`
    WITH ranked AS (
      SELECT submissions.*, ROW_NUMBER() OVER (PARTITION BY steam_id ORDER BY score DESC, verified_at ASC) AS run_rank
      FROM submissions WHERE mode = ?
    )
    SELECT users.display_name AS displayName, users.avatar_url AS avatarUrl,
      SUM(ranked.score) AS score, COUNT(*) AS verifiedWins,
      SUM(ranked.rerolls) AS rerolls, SUM(ranked.cancel_penalties) AS cancelPenalties,
      SUM(ranked.rerolls + ranked.cancel_penalties) AS totalPenalties, SUM(ranked.order_required) AS orderedWins
    FROM ranked JOIN users ON users.steam_id = ranked.steam_id
    WHERE ranked.run_rank <= 10
    GROUP BY ranked.steam_id
    ORDER BY score DESC, totalPenalties ASC, MIN(ranked.verified_at) ASC
    LIMIT 50
  `).bind(mode).all();
  return json({ mode, entries: results }, 200, env);
}

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env) });
  if (request.method === 'GET' && url.pathname === '/health') return json({
    ok: true, rulesVersion: RULES_VERSION, cancelPenalty: CANCEL_PENALTY_ROLLS, matchGuardSeconds: MATCH_GUARD_SECONDS,
    verificationCooldownSeconds: VERIFICATION_REQUEST_COOLDOWN_SECONDS,
    providers: { openDota: true, stratzFallback: Boolean((env as Env & { STRATZ_API_TOKEN?: string }).STRATZ_API_TOKEN) }
  }, 200, env);
  if (request.method === 'GET' && url.pathname === '/auth/steam') return handleSteamLogin(url, env);
  if (request.method === 'GET' && url.pathname === '/auth/steam/callback') return handleSteamCallback(request, url, env);
  if (request.method === 'POST' && url.pathname === '/auth/exchange') return handleExchange(request, env);
  if (request.method === 'GET' && url.pathname === '/me') return json({ user: await getUser(request, env) }, 200, env);
  if (request.method === 'GET' && url.pathname === '/leaderboard') return handleLeaderboard(url, env);
  if (request.method === 'GET' && url.pathname === '/attempts/active') {
    const user = await requireUser(request, env);
    let active = await env.DB.prepare(`SELECT * FROM attempts WHERE steam_id = ? AND status IN ('rolling', 'committed')
      AND created_at > ? ORDER BY created_at DESC LIMIT 1`).bind(user.steam_id, nowSeconds() - ATTEMPT_SECONDS).first<AttemptRow>();
    if (active?.status === 'rolling') {
      const now = nowSeconds();
      await env.DB.prepare("UPDATE attempts SET status = 'committed', committed_at = ?, updated_at = ? WHERE id = ? AND status = 'rolling'")
          .bind(now, now, active.id).run();
      active = await getAttempt(active.id, user.steam_id, env);
    }
    return json({ attempt: active ? challenge(active) : null }, 200, env);
  }
  if (request.method === 'POST' && url.pathname === '/attempts') return handleCreateAttempt(request, env, ctx);

  const match = url.pathname.match(/^\/attempts\/([0-9a-f-]+)\/(reroll|commit|cancel|submit)$/i);
  if (request.method === 'POST' && match) {
    if (match[2] === 'reroll') return handleReroll(match[1], request, env, ctx);
    if (match[2] === 'commit') return handleCommit(match[1], request, env);
    if (match[2] === 'cancel') return handleCancel(match[1], request, env);
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
      return json({ error: message, code: known ? error.code : 'internal_error', ...(known ? error.details : {}) }, known ? error.status : 500, env);
    }
  }
} satisfies ExportedHandler<Env>;