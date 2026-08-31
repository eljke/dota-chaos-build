import { generateBuild, seededRandom } from '../../js/generator.js';
import { BOOT_KEYS, isItemCompatible } from '../../js/item-rules.js';
import { eligibleModifiers, modifierById } from '../../js/modifiers.js';
import { calculateScore, canRetryVerificationJob, canSubmitAttempt, verifyMatch } from './verify.js';
import { verifyVerificationSignature } from './verification-auth.js';
import { normalizeStratzMatch } from './providers.js';

type JsonObject = Record<string, unknown>;
type RankedItem = { id: number; key: string; sourceKey: string; name: string; cost: number; upgradeIds?: number[]; upgradeKeys?: string[] };
type RankedHero = { id: number; key: string; name: string; attack_type: string; roles: string[] };
type RankedPool = { generatedAt: string; heroes: RankedHero[]; items: RankedItem[] };
type ProBuildSampleRow = {
  match_id: string; player_slot: number; mode: 'normal' | 'turbo'; hero_id: number; position: string;
  starting_item_ids: string; core_item_ids: string; player_name: string; leaderboard_rank: number | null; observed_at: number;
};
type UserRow = { steam_id: string; account_id: number; display_name: string; avatar_url: string };
type LoginCodeRow = { steam_id: string };
type PenaltyRow = { cancel_penalties: number; cooldown_until: number };
type VerificationJobStatus = 'queued' | 'running' | 'retry' | 'verified' | 'rejected' | 'error' | 'stale';
type VerificationJobRow = {
  id: string; attempt_id: string; attempt_updated_at: number; steam_id: string; match_id: string;
  status: VerificationJobStatus; message: string; result_json: string | null; created_at: number; updated_at: number; expires_at: number;
};
type QueuedVerificationJobRow = VerificationJobRow & { account_id: number };
type GithubVerifierConfig = { token: string; repository: string; workflow: string; ref: string };
type AttemptRow = {
  id: string; steam_id: string; mode: 'normal' | 'turbo'; order_required: number;
  status: 'rolling' | 'committed' | 'verified' | 'expired'; roll_count: number; seed: string;
  hero_id: number; hero_key: string; hero_name: string; items_json: string; modifier_id: string | null;
  rules_version: string; data_version: string; created_at: number; updated_at: number; committed_at: number | null;
  cancel_penalties: number; verification_retry_at: number;
  deferred_at: number;
  build_style: 'chaos' | 'pro'; position: string | null; starting_items_json: string;
  source_match_id: string | null; source_player: string | null; sample_count: number;
};

const STEAM_OPENID = 'https://steamcommunity.com/openid/login';
const STEAM_PLAYER_SUMMARIES = 'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/';
const STEAM_TOP_LIVE = 'https://api.steampowered.com/IDOTA2Match_570/GetTopLiveGame/v1/';
const STRATZ_API = 'https://api.stratz.com/graphql';
const STRATZ_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const STEAM_ID_BASE = 76561197960265728n;
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const ATTEMPT_SECONDS = 24 * 60 * 60;
const CANCEL_COOLDOWN_SECONDS = 60;
const CANCEL_PENALTY_ROLLS = 1;
const MATCH_GUARD_SECONDS = { normal: 0, turbo: 0 } as const;
const VERIFICATION_JOB_SECONDS = 2 * 60 * 60;
const VERIFICATION_CALLBACK_MAX_BYTES = 256 * 1024;
const VERIFICATION_CALLBACK_MAX_AGE_SECONDS = 10 * 60;
const VERIFICATION_REQUEST_COOLDOWN_SECONDS = 15;
const VERIFICATION_RETRY_SECONDS = 60;
const RULES_VERSION = '2.0.4';
const PRO_SAMPLE_MAX_AGE = 30 * 24 * 60 * 60;
const RECENT_HERO_LIMIT = 5;
const PRO_HERO_SAMPLE_TARGET = 3;
const NON_BUILD_ITEM_IDS = new Set([108, 117, 609]);
const STARTING_BUY_IDS: Record<string, number[]> = {
  POSITION_1: [44, 16, 16, 11, 20, 237],
  POSITION_2: [44, 16, 16, 20, 237, 216],
  POSITION_3: [44, 16, 16, 11, 34, 38],
  POSITION_4: [44, 16, 16, 34, 1123, 38],
  POSITION_5: [44, 16, 16, 34, 1123, 216],
  UNKNOWN: [44, 16, 16, 34, 237, 38]
};

const STRATZ_MATCH_QUERY = `
  query RankedMatch($id: Long!) {
    match(id: $id) {
      id didRadiantWin durationSeconds startDateTime lobbyType gameMode radiantKills direKills
      playbackData { runeEvents { indexId } }
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

const STRATZ_PRO_MATCH_QUERY = `
  query ProBuildMatch($id: Long!) {
    match(id: $id) {
      id startDateTime durationSeconds gameMode lobbyType leagueId
      players {
        steamAccountId playerSlot heroId position isVictory leaverStatus
        item0Id item1Id item2Id item3Id item4Id item5Id backpack0Id backpack1Id backpack2Id
        steamAccount { name seasonRank seasonLeaderboardRank proSteamAccount { name } }
        stats { itemPurchases { itemId time } }
      }
    }
  }
`;

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
  return Response.json(data, { status, headers: { ...corsHeaders(env), 'Cache-Control': 'no-store' } });
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

function createRoll(pool: RankedPool, mode: 'normal' | 'turbo', orderRequired: boolean, excludedHeroIds: number[] = []) {
  const seed = crypto.randomUUID();
  const itemsByKey = Object.fromEntries(pool.items.map(item => [item.key, item]));
  const availableHeroes = pool.heroes.filter(hero => !excludedHeroIds.includes(hero.id));
  const build = generateBuild({
    seed,
    forceBootSlot: true,
    heroes: availableHeroes.length ? availableHeroes : pool.heroes,
    itemPool: pool.items.filter(item => item.key !== 'rapier' && !NON_BUILD_ITEM_IDS.has(item.id)),
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

async function getItemCatalog(env: Env): Promise<Map<number, RankedItem>> {
  const response = await fetch(new URL('data/items.json', env.SITE_URL));
  if (!response.ok) throw new HttpError(503, 'Каталог предметов пока недоступен.', 'item_catalog_unavailable');
  const payload: unknown = await response.json();
  if (!isRecord(payload)) throw new HttpError(503, 'Каталог предметов имеет неверный формат.', 'invalid_item_catalog');
  const catalog = new Map<number, RankedItem>();
  for (const [key, raw] of Object.entries(payload)) {
    if (!isRecord(raw) || !Number.isInteger(raw.id) || typeof raw.img !== 'string') continue;
    catalog.set(Number(raw.id), { id: Number(raw.id), key, sourceKey: key,
      name: typeof raw.dname === 'string' ? raw.dname : key, cost: Number(raw.cost) || 0 });
  }
  return catalog;
}

function resolveItems(idsJson: string, catalog: Map<number, RankedItem>): RankedItem[] {
  const ids: unknown = JSON.parse(idsJson);
  return Array.isArray(ids) ? ids.map(Number).map(id => catalog.get(id)).filter((item): item is RankedItem => Boolean(item)) : [];
}

function fallbackStartingItems(position: string, catalog: Map<number, RankedItem>): RankedItem[] {
  return (STARTING_BUY_IDS[position] || STARTING_BUY_IDS.UNKNOWN)
    .map(id => catalog.get(id)).filter((item): item is RankedItem => Boolean(item));
}

async function recentHeroIds(steamId: string, env: Env): Promise<number[]> {
  const { results } = await env.DB.prepare(`SELECT hero_id FROM attempts WHERE steam_id = ?
    ORDER BY created_at DESC LIMIT ?`).bind(steamId, RECENT_HERO_LIMIT).all<{ hero_id: number }>();
  return results.map(row => Number(row.hero_id));
}

async function createProRoll(
  pool: RankedPool, mode: 'normal' | 'turbo', env: Env, excludedHeroIds: number[] = []
) {
  const cutoff = nowSeconds() - PRO_SAMPLE_MAX_AGE;
  const sourceModes = mode === 'turbo' ? ['turbo', 'normal'] : ['normal'];
  const modePlaceholders = sourceModes.map(() => '?').join(', ');
  const excludedPlaceholders = excludedHeroIds.map(() => '?').join(', ');
  const eligibleWhere = `mode IN (${modePlaceholders}) AND observed_at >= ?
    AND json_array_length(core_item_ids) = 6
    AND NOT EXISTS (SELECT 1 FROM json_each(core_item_ids) WHERE CAST(value AS INTEGER) IN (108, 117, 609))`;
  const exclusion = excludedHeroIds.length ? ` AND hero_id NOT IN (${excludedPlaceholders})` : '';
  let { results: heroes } = await env.DB.prepare(`SELECT hero_id FROM pro_build_samples
    WHERE ${eligibleWhere}${exclusion} GROUP BY hero_id ORDER BY RANDOM() LIMIT 25`)
    .bind(...sourceModes, cutoff, ...excludedHeroIds).all<{ hero_id: number }>();
  if (!heroes.length && excludedHeroIds.length) {
    ({ results: heroes } = await env.DB.prepare(`SELECT hero_id FROM pro_build_samples
      WHERE ${eligibleWhere} GROUP BY hero_id ORDER BY RANDOM() LIMIT 25`)
      .bind(...sourceModes, cutoff).all<{ hero_id: number }>());
  }
  const selectedHero = heroes.map(row => pool.heroes.find(hero => hero.id === Number(row.hero_id))).find(Boolean);
  if (!selectedHero) throw new HttpError(503, mode === 'turbo'
    ? 'Свежая Turbo-выборка ещё собирается. Попробуйте немного позже.'
    : 'Свежая high-MMR выборка ещё собирается. Попробуйте немного позже.', 'pro_pool_warming_up');
  const { results: samples } = await env.DB.prepare(`SELECT * FROM pro_build_samples
    WHERE ${eligibleWhere} AND hero_id = ?
    ORDER BY CASE WHEN mode = ? THEN 0 ELSE 1 END, RANDOM() LIMIT 25`)
    .bind(...sourceModes, cutoff, selectedHero.id, mode).all<ProBuildSampleRow>();
  const catalog = await getItemCatalog(env);
  const selected = samples.map(sample => ({
    sample,
    hero: selectedHero,
    items: resolveItems(sample.core_item_ids, catalog)
      .filter(item => !NON_BUILD_ITEM_IDS.has(item.id) && item.cost > 0)
  })).find(candidate => candidate.hero && candidate.items.length === 6);
  if (!selected?.hero) throw new HttpError(503, 'В свежей STRATZ-выборке пока нет полной покупаемой сборки.', 'pro_pool_incomplete');
  const { sample, hero, items } = selected;
  const sourceStartingItems = resolveItems(sample.starting_item_ids, catalog).filter(item => item.id !== 117);
  const startingItems = sourceStartingItems.length ? sourceStartingItems : fallbackStartingItems(sample.position, catalog);
  const count = await env.DB.prepare(`SELECT COUNT(*) AS count FROM pro_build_samples
    WHERE mode IN (${modePlaceholders}) AND hero_id = ? AND position = ? AND observed_at >= ?`)
    .bind(...sourceModes, sample.hero_id, sample.position, cutoff).first<{ count: number }>();
  const seed = crypto.randomUUID();
  const modifiers = eligibleModifiers({ hero, items });
  const modifier = modifiers[Math.floor(seededRandom(`modifier:${seed}`)() * modifiers.length)];
  return { seed, mode, orderRequired: true, hero, items, startingItems, modifier,
    position: sample.position, sourceMatchId: sample.match_id, sourcePlayer: sample.player_name,
    sampleCount: Number(count?.count || 1), dataVersion: sample.observed_at };
}

function challenge(row: AttemptRow) {
  const items: RankedItem[] = JSON.parse(row.items_json);
  const startingItems: RankedItem[] = JSON.parse(row.starting_items_json || '[]');
  const modifier = modifierById(row.modifier_id);
  const cancelPenalties = Number(row.cancel_penalties || 0);
  const committedAt = Number(row.committed_at || row.updated_at);
  const matchGuardSeconds = MATCH_GUARD_SECONDS[row.mode];
  return {
    id: row.id,
    status: row.status,
    mode: row.mode,
    buildStyle: row.build_style || 'chaos',
    orderRequired: row.order_required === 1,
    rerolls: row.roll_count,
    cancelPenalties,
    totalPenalties: row.roll_count + cancelPenalties,
    rollsSeen: row.roll_count + 1,
    scorePreview: calculateScore({
      rerolls: row.roll_count,
      cancelPenalties,
      orderRequired: row.order_required === 1,
      startingBuyCompleted: row.build_style === 'pro' && startingItems.length > 0,
      modifierMultiplier: modifier?.multiplier
    }),
    hero: { id: row.hero_id, key: row.hero_key, name: row.hero_name },
    items,
    startingItems,
    position: row.position,
    source: row.build_style === 'pro' ? {
      provider: 'STRATZ', matchId: row.source_match_id, player: row.source_player, sampleCount: row.sample_count
    } : null,
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

async function getAttemptById(id: string, env: Env): Promise<AttemptRow | null> {
  return env.DB.prepare('SELECT * FROM attempts WHERE id = ?').bind(id).first<AttemptRow>();
}

async function claimVerificationRequest(attemptId: string, steamId: string, env: Env): Promise<void> {
  const now = nowSeconds();
  const retryAt = now + VERIFICATION_REQUEST_COOLDOWN_SECONDS;
  const claimed = await env.DB.prepare(`UPDATE attempts SET verification_retry_at = ?
    WHERE id = ? AND steam_id = ? AND status IN ('committed', 'expired') AND verification_retry_at <= ?`)
    .bind(retryAt, attemptId, steamId, now).run();
  if (claimed.meta.changes === 1) return;

  const row = await env.DB.prepare('SELECT verification_retry_at FROM attempts WHERE id = ? AND steam_id = ?')
    .bind(attemptId, steamId).first<{ verification_retry_at: number }>();
  const retryAfter = Math.max(1, Number(row?.verification_retry_at || retryAt) - now);
  throw new HttpError(429, `Повторная проверка будет доступна через ${retryAfter} сек.`, 'verification_cooldown', { retryAfter });
}

function getGithubVerifierConfig(env: Env): GithubVerifierConfig {
  const values = env as Env & {
    GITHUB_ACTIONS_TOKEN?: string;
    GITHUB_REPOSITORY?: string;
    GITHUB_WORKFLOW_FILE?: string;
    GITHUB_WORKFLOW_REF?: string;
  };
  const token = String(values.GITHUB_ACTIONS_TOKEN || '').trim();
  const repository = String(values.GITHUB_REPOSITORY || 'eljke/dota-chaos-build').trim();
  const workflow = String(values.GITHUB_WORKFLOW_FILE || 'verify-ranked-match.yml').trim();
  const ref = String(values.GITHUB_WORKFLOW_REF || 'master').trim();
  if (!token) throw new HttpError(503, 'GitHub Actions verifier не настроен.', 'github_verifier_not_configured');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !workflow || !ref) {
    throw new HttpError(503, 'GitHub Actions verifier настроен неверно.', 'github_verifier_misconfigured');
  }
  return { token, repository, workflow, ref };
}

function callbackSecret(env: Env): string {
  const secret = String((env as Env & { VERIFICATION_CALLBACK_SECRET?: string }).VERIFICATION_CALLBACK_SECRET || '').trim();
  if (secret.length < 32) throw new HttpError(503, 'Callback verifier не настроен.', 'verification_callback_not_configured');
  return secret;
}

function verificationAttempt(attempt: AttemptRow) {
  return {
    hero_id: attempt.hero_id,
    mode: attempt.mode,
    order_required: attempt.order_required,
    modifier_id: attempt.modifier_id,
    committed_at: attempt.committed_at,
    build_style: attempt.build_style,
    match_guard_seconds: MATCH_GUARD_SECONDS[attempt.mode],
    items: JSON.parse(attempt.items_json),
    starting_items: JSON.parse(attempt.starting_items_json || '[]')
  };
}

async function dispatchVerificationJob(job: VerificationJobRow, attempt: AttemptRow, accountId: number, env: Env): Promise<void> {
  const config = getGithubVerifierConfig(env);
  const attemptPayload = JSON.stringify(verificationAttempt(attempt));
  if (attemptPayload.length > 50_000) throw new HttpError(500, 'Снимок ranked-попытки слишком большой.', 'attempt_payload_too_large');
  const endpoint = `https://api.github.com/repos/${config.repository}/actions/workflows/${encodeURIComponent(config.workflow)}/dispatches`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'dota-chaos-ranked-worker/2.0.4',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: JSON.stringify({
      ref: config.ref,
      inputs: {
        job_id: job.id,
        match_id: job.match_id,
        account_id: String(accountId),
        attempt_payload: attemptPayload
      }
    })
  });
  if (response.status !== 204) {
    const responseBody = (await response.text().catch(() => '')).slice(0, 1000);
    console.warn('GitHub workflow dispatch failed:', response.status, responseBody);
    throw new HttpError(502, 'GitHub Actions не приняла задачу проверки.', 'github_dispatch_failed');
  }
}

async function expireVerificationJobs(attemptId: string, env: Env): Promise<void> {
  const now = nowSeconds();
  await env.DB.prepare(`UPDATE verification_jobs
    SET status = 'error', message = ?, updated_at = ?
    WHERE attempt_id = ? AND status IN ('queued', 'running', 'retry') AND expires_at <= ?`)
    .bind('Не удалось дождаться данных матча. Проверку можно отправить заново.', now, attemptId, now).run();
}

async function activeVerificationJob(attemptId: string, env: Env): Promise<VerificationJobRow | null> {
  await expireVerificationJobs(attemptId, env);
  return env.DB.prepare(`SELECT * FROM verification_jobs
    WHERE attempt_id = ? AND status IN ('queued', 'running', 'retry') AND expires_at > ?
    ORDER BY created_at DESC LIMIT 1`)
    .bind(attemptId, nowSeconds()).first<VerificationJobRow>();
}

async function latestVerificationJob(attemptId: string, env: Env): Promise<VerificationJobRow | null> {
  await expireVerificationJobs(attemptId, env);
  return env.DB.prepare('SELECT * FROM verification_jobs WHERE attempt_id = ? ORDER BY created_at DESC LIMIT 1')
    .bind(attemptId).first<VerificationJobRow>();
}

function parseJobResult(job: VerificationJobRow): JsonObject | null {
  if (!job.result_json) return null;
  try {
    const value: unknown = JSON.parse(job.result_json);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function verificationJobPayload(job: VerificationJobRow, attempt?: AttemptRow | null) {
  const manualRetry = canRetryVerificationJob(job);
  const retryAfter = job.status === 'retry'
    ? Math.max(1, Number(attempt?.verification_retry_at || nowSeconds() + 15) - nowSeconds())
    : ['queued', 'running'].includes(job.status) ? 5
      : manualRetry ? Math.max(0, Number(attempt?.verification_retry_at || 0) - nowSeconds()) : 0;
  return {
    jobId: job.id,
    attemptId: job.attempt_id,
    matchId: job.match_id,
    status: job.status,
    message: job.message,
    retryAfter,
    retryable: manualRetry,
    canRetry: manualRetry && retryAfter === 0,
    result: parseJobResult(job),
    updatedAt: job.updated_at
  };
}

function verificationRetryDelay(job: VerificationJobRow): number {
  const age = Math.max(0, nowSeconds() - job.created_at);
  if (age < 10 * 60) return 60;
  if (age < 30 * 60) return 3 * 60;
  return 10 * 60;
}

async function handleVerificationQueue(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const now = nowSeconds();
  await env.DB.prepare(`UPDATE verification_jobs SET status = 'error', message = ?, updated_at = ?
    WHERE steam_id = ? AND status IN ('queued', 'running', 'retry') AND expires_at <= ?`)
    .bind('Не удалось дождаться данных матча. Проверку можно отправить заново.', now, user.steam_id, now).run();
  const { results } = await env.DB.prepare(`SELECT verification_jobs.* FROM verification_jobs
    WHERE steam_id = ? AND created_at > ?
      AND NOT EXISTS (SELECT 1 FROM verification_jobs AS newer
        WHERE newer.attempt_id = verification_jobs.attempt_id AND newer.created_at > verification_jobs.created_at)
    ORDER BY created_at DESC LIMIT 10`)
    .bind(user.steam_id, now - 24 * 60 * 60).all<VerificationJobRow>();
  const jobs = await Promise.all(results.map(async job => {
    const attempt = await getAttemptById(job.attempt_id, env);
    return { ...verificationJobPayload(job, attempt), mode: attempt?.mode || 'normal',
      buildStyle: attempt?.build_style || 'chaos', heroName: attempt?.hero_name || '' };
  }));
  const { results: deferred } = await env.DB.prepare(`SELECT id, mode, hero_name, deferred_at FROM attempts
    WHERE steam_id = ? AND status = 'expired' AND deferred_at > ?
    ORDER BY deferred_at DESC LIMIT 10`).bind(user.steam_id, now - 7 * 24 * 60 * 60)
    .all<{ id: string; mode: 'normal' | 'turbo'; hero_name: string; deferred_at: number }>();
  return json({ jobs: [
    ...deferred.map(attempt => ({
      jobId: `deferred:${attempt.id}`, attemptId: attempt.id, matchId: '', status: 'awaiting_match_id',
      message: '', retryAfter: 0, result: null, updatedAt: attempt.deferred_at,
      mode: attempt.mode, heroName: attempt.hero_name
    })),
    ...jobs
  ] }, 200, env);
}

async function processVerificationQueue(env: Env): Promise<void> {
  const now = nowSeconds();
  await env.DB.prepare(`UPDATE verification_jobs SET status = 'error', message = ?, updated_at = ?
    WHERE status IN ('queued', 'running', 'retry') AND expires_at <= ?`)
    .bind('Не удалось дождаться данных матча. Проверку можно отправить заново.', now, now).run();
  const { results } = await env.DB.prepare(`SELECT verification_jobs.*, users.account_id
    FROM verification_jobs
    JOIN attempts ON attempts.id = verification_jobs.attempt_id
    JOIN users ON users.steam_id = verification_jobs.steam_id
    WHERE verification_jobs.status = 'retry' AND verification_jobs.expires_at > ?
      AND attempts.status IN ('committed', 'expired')
      AND attempts.updated_at = verification_jobs.attempt_updated_at
      AND attempts.verification_retry_at <= ?
      AND NOT EXISTS (SELECT 1 FROM verification_jobs AS newer
        WHERE newer.attempt_id = verification_jobs.attempt_id AND newer.created_at > verification_jobs.created_at)
    ORDER BY verification_jobs.updated_at LIMIT 5`)
    .bind(now, now).all<QueuedVerificationJobRow>();

  for (const job of results) {
    const claimed = await env.DB.prepare(`UPDATE verification_jobs SET status = 'queued', message = ?, updated_at = ?
      WHERE id = ? AND status = 'retry'`).bind('Повторная проверка поставлена в очередь.', now, job.id).run();
    if (claimed.meta.changes !== 1) continue;
    const attempt = await getAttemptById(job.attempt_id, env);
    if (!attempt) continue;
    try {
      await dispatchVerificationJob({ ...job, status: 'queued', updated_at: now }, attempt, job.account_id, env);
      console.log(JSON.stringify({ message: 'verification retry dispatched', jobId: job.id, matchId: job.match_id }));
    } catch (error) {
      const retryAt = nowSeconds() + VERIFICATION_RETRY_SECONDS;
      await env.DB.batch([
        env.DB.prepare("UPDATE verification_jobs SET status = 'retry', message = ?, updated_at = ? WHERE id = ?")
          .bind('Не удалось запустить проверку. Повторим автоматически.', nowSeconds(), job.id),
        env.DB.prepare('UPDATE attempts SET verification_retry_at = ? WHERE id = ?')
          .bind(retryAt, job.attempt_id)
      ]);
      console.error(JSON.stringify({ message: 'verification retry dispatch failed', jobId: job.id,
        error: error instanceof Error ? error.message : String(error) }));
    }
  }
}

function stratzEnumNumber(value: unknown, values: Record<string, number>): number {
  return typeof value === 'string' && value in values ? values[value] : Number(value || 0);
}

async function fetchProMatch(matchId: string, env: Env): Promise<JsonObject | null> {
  const token = String((env as Env & { STRATZ_API_TOKEN?: string }).STRATZ_API_TOKEN || '').trim();
  if (!token) return null;
  const response = await fetch(STRATZ_API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json',
      'User-Agent': STRATZ_USER_AGENT },
    body: JSON.stringify({ query: STRATZ_PRO_MATCH_QUERY, variables: { id: Number(matchId) } })
  });
  if (!response.ok) throw new Error(`STRATZ pro-build refresh returned ${response.status}`);
  const payload: unknown = await response.json();
  return isRecord(payload) && isRecord(payload.data) && isRecord(payload.data.match) ? payload.data.match : null;
}

async function discoverLiveMatches(env: Env): Promise<number> {
  const apiKey = String((env as Env & { STEAM_API_KEY?: string }).STEAM_API_KEY || '').trim();
  if (!apiKey) throw new Error('Steam API key is not configured');
  const url = new URL(STEAM_TOP_LIVE);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('partner', '0');
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Steam live-match refresh returned ${response.status}`);
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.game_list)) return 0;
  const candidates = payload.game_list.filter(isRecord).filter(match => {
    const gameMode = Number(match.game_mode || 0);
    const lobbyType = Number(match.lobby_type || 0);
    const highMmr = gameMode === 23 || Number(match.average_mmr || 0) >= 7000;
    const publicGame = Number(match.league_id || 0) === 0;
    return highMmr && publicGame && (gameMode === 23 || gameMode === 22 && lobbyType === 7);
  });
  if (!candidates.length) return 0;
  const now = nowSeconds();
  const statements = candidates.slice(0, 90).map(match => env.DB.prepare(`INSERT OR IGNORE INTO pro_refresh_seen
    (match_id, mode, processed_at, sample_count) VALUES (?, ?, ?, -1)`)
    .bind(String(match.match_id), Number(match.game_mode) === 23 ? 'turbo' : 'normal',
      Number(match.activate_time || now)));
  await env.DB.batch(statements);
  return statements.length;
}

async function processProBuildCandidate(
  candidate: { match_id: string; mode: 'normal' | 'turbo' }, env: Env, now: number
): Promise<number> {
  const { match_id: matchId, mode } = candidate;
  const match = await fetchProMatch(matchId, env);
  if (!match || Number(match.durationSeconds || 0) <= 0) {
    await env.DB.prepare('UPDATE pro_refresh_seen SET processed_at = ? WHERE match_id = ?').bind(now, matchId).run();
    return 0;
  }
  const statements = [];
  let sampleCount = 0;

  const minimumDuration = mode === 'turbo' ? 12 * 60 : 20 * 60;
  if (match && !match.leagueId && Number(match.durationSeconds || 0) >= minimumDuration) {
    const catalog = await getItemCatalog(env);
    const gameMode = stratzEnumNumber(match.gameMode, { ALL_PICK: 1, ALL_PICK_RANKED: 22, TURBO: 23 });
    const players = Array.isArray(match.players) ? match.players.filter(isRecord) : [];
    if ((mode === 'turbo') === (gameMode === 23)) for (const player of players) {
      const steam = isRecord(player.steamAccount) ? player.steamAccount : {};
      const rank = Number(steam.seasonRank || 0);
      const leaderboardRank = Number(steam.seasonLeaderboardRank || 0);
      const pro = isRecord(steam.proSteamAccount) ? steam.proSteamAccount : null;
      const highMmr = rank >= 80 && (mode === 'turbo' || leaderboardRank > 0 && leaderboardRank <= 2000 || Boolean(pro));
      const purchases = isRecord(player.stats) && Array.isArray(player.stats.itemPurchases)
        ? player.stats.itemPurchases.filter(isRecord) : [];
      if (!highMmr || Number(player.steamAccountId || 0) <= 0
        || player.isVictory !== true || String(player.leaverStatus || 'NONE') !== 'NONE') continue;
      const finalIds = [player.item0Id, player.item1Id, player.item2Id, player.item3Id, player.item4Id, player.item5Id,
        player.backpack0Id, player.backpack1Id, player.backpack2Id]
        .map(Number).filter(id => id > 0 && !NON_BUILD_ITEM_IDS.has(id) && Number(catalog.get(id)?.cost || 0) > 0);
      const purchaseTimes = new Map<number, number[]>();
      for (const event of purchases) {
        const id = Number(event.itemId || 0);
        if (id > 0) purchaseTimes.set(id, [...(purchaseTimes.get(id) || []), Number(event.time || 0)]);
      }
      const occurrences = new Map<number, number>();
      const coreIds = finalIds.map((id, slot) => {
        const occurrence = occurrences.get(id) || 0;
        occurrences.set(id, occurrence + 1);
        return { id, slot, time: purchaseTimes.get(id)?.[occurrence] ?? Number.MAX_SAFE_INTEGER };
      }).sort((left, right) => left.time - right.time || left.slot - right.slot).slice(0, 6).map(entry => entry.id);
      const coreItems = coreIds.map(id => catalog.get(id));
      if (coreIds.length !== 6 || coreItems.some(item => !item)) continue;
      const totalCost = coreItems.reduce((sum, item) => sum + item!.cost, 0);
      const majorItems = coreItems.filter(item => item!.cost >= 2000).length;
      if (totalCost < (mode === 'turbo' ? 10000 : 12000) || majorItems < 2) continue;
      const startingIds = purchases.filter(event => Number(event.time || 0) <= 0)
        .map(event => Number(event.itemId || 0)).filter(id => id > 0).slice(0, 8);
      const position = /^POSITION_[1-5]$/.test(String(player.position)) ? String(player.position) : 'UNKNOWN';
      const playerName = String(pro?.name || steam.name || `Immortal #${leaderboardRank || '?'}`).slice(0, 80);
      statements.push(env.DB.prepare(`INSERT INTO pro_build_samples
        (match_id, player_slot, mode, hero_id, position, starting_item_ids, core_item_ids, player_name, leaderboard_rank, observed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(match_id, player_slot) DO UPDATE SET
        starting_item_ids = excluded.starting_item_ids, core_item_ids = excluded.core_item_ids,
        player_name = excluded.player_name, leaderboard_rank = excluded.leaderboard_rank, observed_at = excluded.observed_at`)
        .bind(matchId, Number(player.playerSlot || 0), mode, Number(player.heroId), position,
          JSON.stringify(startingIds), JSON.stringify(coreIds), playerName, leaderboardRank || null,
          Number(match.startDateTime || now)));
      sampleCount += 1;
    }
  }
  statements.push(env.DB.prepare(`INSERT INTO pro_refresh_seen (match_id, mode, processed_at, sample_count)
    VALUES (?, ?, ?, ?) ON CONFLICT(match_id) DO UPDATE SET processed_at = excluded.processed_at,
    sample_count = excluded.sample_count`).bind(matchId, mode, now, sampleCount));
  await env.DB.batch(statements);
  return sampleCount;
}

async function processProBuildRefresh(env: Env, discover: boolean): Promise<void> {
  const now = nowSeconds();
  const discovered = discover ? await discoverLiveMatches(env) : 0;
  const { results: candidates } = await env.DB.prepare(`SELECT match_id, mode FROM pro_refresh_seen
    WHERE sample_count = -1 AND processed_at <= ? ORDER BY processed_at LIMIT 3`)
    .bind(now - 10 * 60).all<{ match_id: string; mode: 'normal' | 'turbo' }>();
  let samples = 0;
  for (const candidate of candidates) samples += await processProBuildCandidate(candidate, env, now);
  await env.DB.prepare('DELETE FROM pro_build_samples WHERE observed_at < ?').bind(now - PRO_SAMPLE_MAX_AGE).run();
  await env.DB.prepare('DELETE FROM pro_refresh_seen WHERE processed_at < ?').bind(now - PRO_SAMPLE_MAX_AGE).run();
  console.log(JSON.stringify({ message: 'pro-build refresh completed', processed: candidates.length, samples, discovered }));
}

async function proPoolNeedsCoverage(env: Env): Promise<boolean> {
  const response = await fetch(new URL('data/ranked-pool.json', env.SITE_URL));
  if (!response.ok) return false;
  const pool: unknown = await response.json();
  if (!isRankedPool(pool)) return false;
  const cutoff = nowSeconds() - PRO_SAMPLE_MAX_AGE;
  const coverage = await env.DB.prepare(`SELECT COUNT(*) AS heroes FROM (
    SELECT hero_id FROM pro_build_samples WHERE observed_at >= ?
      AND json_array_length(core_item_ids) = 6
      AND NOT EXISTS (SELECT 1 FROM json_each(core_item_ids) WHERE CAST(value AS INTEGER) IN (108, 117, 609))
    GROUP BY hero_id HAVING COUNT(*) >= ?
  )`).bind(cutoff, PRO_HERO_SAMPLE_TARGET).first<{ heroes: number }>();
  return Number(coverage?.heroes || 0) < pool.heroes.length;
}

async function ensureNoActiveVerification(attemptId: string, env: Env): Promise<void> {
  const active = await activeVerificationJob(attemptId, env);
  if (active) {
    throw new HttpError(409, 'Дождитесь окончания серверной проверки матча.', 'verification_in_progress', {
      jobId: active.id,
      retryAfter: 5
    });
  }
}

async function readCallbackBody(request: Request): Promise<{ raw: string; value: JsonObject }> {
  const declaredSize = Number(request.headers.get('content-length') || 0);
  if (declaredSize > VERIFICATION_CALLBACK_MAX_BYTES) {
    throw new HttpError(413, 'Callback payload слишком большой.', 'payload_too_large');
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > VERIFICATION_CALLBACK_MAX_BYTES) {
    throw new HttpError(413, 'Callback payload слишком большой.', 'payload_too_large');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Callback содержит неверный JSON.', 'invalid_json');
  }
  if (!isRecord(parsed)) throw new HttpError(400, 'Callback должен быть JSON-объектом.', 'invalid_json');
  return { raw, value: parsed };
}

async function verifyInternalRequest(request: Request, raw: string, env: Env): Promise<void> {
  const timestamp = String(request.headers.get('x-verification-timestamp') || '');
  const signature = String(request.headers.get('x-verification-signature') || '');
  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber) || Math.abs(nowSeconds() - timestampNumber) > VERIFICATION_CALLBACK_MAX_AGE_SECONDS) {
    throw new HttpError(401, 'Внутренний запрос устарел.', 'invalid_callback_timestamp');
  }
  if (!await verifyVerificationSignature(callbackSecret(env), timestamp, raw, signature)) {
    throw new HttpError(401, 'Неверная подпись внутреннего запроса.', 'invalid_callback_signature');
  }
}

async function handleStratzMatch(request: Request, env: Env): Promise<Response> {
  const { raw, value } = await readCallbackBody(request);
  await verifyInternalRequest(request, raw, env);

  const jobId = typeof value.jobId === 'string' ? value.jobId : '';
  const matchId = typeof value.matchId === 'string' ? value.matchId : '';
  const accountId = Number(value.accountId || 0);
  if (!/^[0-9a-f-]{36}$/i.test(jobId) || !/^\d{8,12}$/.test(matchId) || !Number.isInteger(accountId) || accountId <= 0) {
    throw new HttpError(400, 'Некорректные параметры STRATZ-запроса.', 'invalid_stratz_request');
  }

  const job = await env.DB.prepare('SELECT * FROM verification_jobs WHERE id = ?').bind(jobId).first<VerificationJobRow>();
  if (!job || job.match_id !== matchId || !['queued', 'running'].includes(job.status)) {
    throw new HttpError(404, 'Активная задача проверки не найдена.', 'verification_job_not_found');
  }
  const user = await env.DB.prepare('SELECT account_id FROM users WHERE steam_id = ?')
    .bind(job.steam_id).first<{ account_id: number }>();
  if (!user || Number(user.account_id) !== accountId) {
    throw new HttpError(403, 'Игрок задачи проверки не совпадает.', 'verification_user_mismatch');
  }

  const token = String((env as Env & { STRATZ_API_TOKEN?: string }).STRATZ_API_TOKEN || '').trim();
  if (!token) {
    throw new HttpError(503, 'STRATZ_API_TOKEN не настроен в Cloudflare Worker.', 'stratz_not_configured');
  }

  let response: Response;
  try {
    response = await fetch(STRATZ_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/graphql-response+json, application/json',
        'User-Agent': STRATZ_USER_AGENT
      },
      body: JSON.stringify({
        query: STRATZ_MATCH_QUERY,
        variables: { id: Number(matchId) }
      })
    });
  } catch (error) {
    console.warn('STRATZ Worker proxy network error:', error);
    throw new HttpError(502, 'STRATZ временно недоступен через Worker.', 'stratz_unreachable');
  }

  const responseText = await response.text().catch(() => '');
  if (!response.ok) {
    console.warn('STRATZ Worker proxy non-OK:', {
      status: response.status,
      cfRay: response.headers.get('cf-ray'),
      body: responseText.slice(0, 1000)
    });
    throw new HttpError(502, `STRATZ вернул HTTP ${response.status}.`, 'stratz_unavailable', {
      upstreamStatus: response.status,
      upstreamError: responseText.slice(0, 500)
    });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new HttpError(502, 'STRATZ вернул некорректный JSON.', 'invalid_stratz_response');
  }
  if (!isRecord(payload)) {
    throw new HttpError(502, 'STRATZ вернул некорректный ответ.', 'invalid_stratz_response');
  }
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    console.warn('STRATZ GraphQL errors:', JSON.stringify(payload.errors).slice(0, 1000));
  }

  const match = normalizeStratzMatch(payload);
  return json({ match }, 200, env);
}

async function handleVerificationCallback(request: Request, env: Env): Promise<Response> {
  const { raw, value } = await readCallbackBody(request);
  await verifyInternalRequest(request, raw, env);

  const jobId = typeof value.jobId === 'string' ? value.jobId : '';
  const matchId = typeof value.matchId === 'string' ? value.matchId : '';
  const callbackStatus = typeof value.status === 'string' ? value.status : '';
  const job = await env.DB.prepare('SELECT * FROM verification_jobs WHERE id = ?').bind(jobId).first<VerificationJobRow>();
  if (!job || job.match_id !== matchId) throw new HttpError(404, 'Задача проверки не найдена.', 'verification_job_not_found');
  if (['verified', 'rejected', 'error', 'stale'].includes(job.status)) return json({ ok: true, status: job.status }, 200, env);

  const now = nowSeconds();
  const message = typeof value.message === 'string' ? value.message.slice(0, 500) : '';
  if (callbackStatus === 'running') {
    await env.DB.prepare("UPDATE verification_jobs SET status = 'running', message = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'retry')")
      .bind(message || 'GitHub Actions проверяет матч.', now, job.id).run();
    return json({ ok: true, status: 'running' }, 200, env);
  }

  if (callbackStatus === 'retry' || callbackStatus === 'error') {
    const retryAfter = Math.max(verificationRetryDelay(job), Math.min(3600, Number(value.retryAfter || VERIFICATION_RETRY_SECONDS)));
    const status: VerificationJobStatus = callbackStatus === 'retry' ? 'retry' : 'error';
    await env.DB.batch([
      env.DB.prepare('UPDATE verification_jobs SET status = ?, message = ?, updated_at = ? WHERE id = ?')
        .bind(status, message || 'Проверка временно не завершена.', now, job.id),
      env.DB.prepare(`UPDATE attempts SET verification_retry_at = MAX(verification_retry_at, ?)
        WHERE id = ? AND status IN ('committed', 'expired')`)
        .bind(now + retryAfter, job.attempt_id)
    ]);
    return json({ ok: true, status }, 200, env);
  }

  if (callbackStatus !== 'completed' || !isRecord(value.match)) {
    throw new HttpError(400, 'Callback имеет неизвестный статус.', 'invalid_callback_status');
  }

  const attempt = await getAttemptById(job.attempt_id, env);
  if (!attempt || !['committed', 'expired'].includes(attempt.status) || attempt.updated_at !== job.attempt_updated_at) {
    await env.DB.prepare("UPDATE verification_jobs SET status = 'stale', message = ?, updated_at = ? WHERE id = ?")
      .bind('Ranked-сборка изменилась до завершения проверки.', now, job.id).run();
    return json({ ok: true, status: 'stale' }, 200, env);
  }
  const user = await env.DB.prepare('SELECT steam_id, account_id, display_name, avatar_url FROM users WHERE steam_id = ?')
    .bind(job.steam_id).first<UserRow>();
  if (!user) throw new HttpError(404, 'Игрок задачи проверки не найден.', 'verification_user_not_found');

  const proof = verifyMatch({ match: value.match, attempt: verificationAttempt(attempt), accountId: user.account_id });
  if (!proof.parsed) {
    const retryAfter = verificationRetryDelay(job);
    await env.DB.batch([
      env.DB.prepare("UPDATE verification_jobs SET status = 'retry', message = ?, result_json = ?, updated_at = ? WHERE id = ?")
        .bind('Реплей ещё не содержит журнал покупок.', JSON.stringify({ errorCodes: proof.errorCodes, errors: proof.errors }), now, job.id),
      env.DB.prepare("UPDATE attempts SET verification_retry_at = ? WHERE id = ? AND status IN ('committed', 'expired')")
        .bind(now + retryAfter, attempt.id)
    ]);
    return json({ ok: true, status: 'retry' }, 200, env);
  }

  if (!proof.ok) {
    const result = { errorCodes: proof.errorCodes, errors: proof.errors, evidence: proof.evidence };
    await env.DB.batch([
      env.DB.prepare("UPDATE verification_jobs SET status = 'rejected', message = ?, result_json = ?, updated_at = ? WHERE id = ?")
        .bind(proof.errors.join(' ').slice(0, 500), JSON.stringify(result), now, job.id),
      env.DB.prepare("UPDATE attempts SET verification_retry_at = ? WHERE id = ? AND status IN ('committed', 'expired')")
        .bind(now + VERIFICATION_REQUEST_COOLDOWN_SECONDS, attempt.id)
    ]);
    return json({ ok: true, status: 'rejected' }, 200, env);
  }

  const modifier = modifierById(attempt.modifier_id);
  const cancelPenalties = Number(attempt.cancel_penalties || 0);
  const completedItems = Number(proof.completedItems || 0);
  const totalItems = Number(proof.totalItems || 6);
  const completionValue = Number(proof.completionMultiplier || 0);
  const orderCompleted = proof.orderCompleted !== false;
  const startingBuyCompleted = proof.startingBuyCompleted === true;
  const modifierCompleted = proof.modifierCompleted === true;
  const score = calculateScore({
    rerolls: attempt.roll_count,
    cancelPenalties,
    orderRequired: attempt.order_required === 1 && orderCompleted,
    startingBuyCompleted,
    modifierMultiplier: modifierCompleted ? modifier?.multiplier : 1,
    completedItems,
    totalItems
  });
  const result = {
    score,
    source: typeof value.source === 'string' ? value.source : 'github-actions-opendota',
    completedItems,
    totalItems,
    completionMultiplier: completionValue,
    orderCompleted,
    startingBuyCompleted,
    modifierCompleted,
    modifierId: modifier?.id || null,
    evidence: proof.evidence
  };

  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO submissions
        (id, attempt_id, steam_id, match_id, score, rerolls, cancel_penalties, order_required, mode, modifier_id,
         evidence_json, verified_at, completion_items, completion_total, completion_multiplier, build_style)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`) 
        .bind(crypto.randomUUID(), attempt.id, user.steam_id, matchId, score, attempt.roll_count, cancelPenalties,
          attempt.order_required, attempt.mode, attempt.modifier_id, JSON.stringify(result), now,
          completedItems, totalItems, completionValue, attempt.build_style || 'chaos'),
      env.DB.prepare("UPDATE attempts SET status = 'verified', updated_at = ? WHERE id = ? AND status IN ('committed', 'expired') AND updated_at = ?")
        .bind(now, attempt.id, job.attempt_updated_at),
      env.DB.prepare("UPDATE verification_jobs SET status = 'verified', message = ?, result_json = ?, updated_at = ? WHERE id = ?")
        .bind(`Победа подтверждена: собрано ${completedItems}/${totalItems} предметов.${modifier && !modifierCompleted
          ? ` Дополнительное условие не выполнено: ${modifier.name}.` : ''}`, JSON.stringify(result), now, job.id),
      env.DB.prepare(`INSERT INTO ranked_penalties (steam_id, mode, cancel_penalties, cooldown_until, updated_at)
        VALUES (?, ?, 0, 0, ?) ON CONFLICT(steam_id, mode) DO UPDATE SET cancel_penalties = 0,
        cooldown_until = 0, updated_at = excluded.updated_at`)
        .bind(user.steam_id, attempt.mode, now)
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
      await env.DB.prepare("UPDATE verification_jobs SET status = 'error', message = ?, updated_at = ? WHERE id = ?")
        .bind('Этот матч или попытка уже подтверждены.', now, job.id).run();
      return json({ ok: true, status: 'error' }, 200, env);
    }
    throw error;
  }
  return json({ ok: true, status: 'verified', score }, 200, env);
}

async function handleVerificationStatus(id: string, request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const attempt = await getAttempt(id, user.steam_id, env);
  const job = await latestVerificationJob(attempt.id, env);
  return json(job ? verificationJobPayload(job, attempt) : { status: 'idle' }, 200, env);
}

async function handleCreateAttempt(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const mode = body.mode === 'turbo' ? 'turbo' : 'normal';
  const buildStyle = body.buildStyle === 'pro' ? 'pro' : 'chaos';
  const orderRequired = buildStyle === 'pro' || body.orderRequired === true;
  const now = nowSeconds();
  let active = await env.DB.prepare(`SELECT * FROM attempts
    WHERE steam_id = ? AND status IN ('rolling', 'committed') AND created_at > ?
      AND NOT EXISTS (SELECT 1 FROM verification_jobs WHERE verification_jobs.attempt_id = attempts.id
        AND verification_jobs.status IN ('queued', 'running', 'retry'))
    ORDER BY created_at DESC LIMIT 1`)
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
    WHERE steam_id = ? AND status IN ('rolling', 'committed')
      AND NOT EXISTS (SELECT 1 FROM verification_jobs WHERE verification_jobs.attempt_id = attempts.id
        AND verification_jobs.status IN ('queued', 'running', 'retry'))`).bind(now, user.steam_id).run();
  const pool = await getPool(env, ctx);
  const excludedHeroIds = await recentHeroIds(user.steam_id, env);
  const roll = buildStyle === 'pro'
    ? await createProRoll(pool, mode, env, excludedHeroIds)
    : createRoll(pool, mode, orderRequired, excludedHeroIds);
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO attempts
    (id, steam_id, mode, order_required, status, roll_count, cancel_penalties, seed, hero_id, hero_key, hero_name, items_json,
     modifier_id, rules_version, data_version, created_at, updated_at, committed_at, build_style, position, starting_items_json,
     source_match_id, source_player, sample_count)
    VALUES (?, ?, ?, ?, 'committed', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, user.steam_id, mode, orderRequired ? 1 : 0, penalty.cancel_penalties, roll.seed, roll.hero.id, roll.hero.key, roll.hero.name,
      JSON.stringify(roll.items), roll.modifier.id, RULES_VERSION,
      'dataVersion' in roll ? String(roll.dataVersion) : pool.generatedAt, now, now, now, buildStyle,
      'position' in roll ? roll.position : null, JSON.stringify('startingItems' in roll ? roll.startingItems : []),
      'sourceMatchId' in roll ? roll.sourceMatchId : null, 'sourcePlayer' in roll ? roll.sourcePlayer : null,
      'sampleCount' in roll ? roll.sampleCount : 0).run();
  return json({ attempt: challenge(await getAttempt(id, user.steam_id, env)) }, 201, env);
}

async function handleReroll(id: string, request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const user = await requireUser(request, env);
  const current = await getAttempt(id, user.steam_id, env);
  if (current.status !== 'committed') throw new HttpError(409, 'Эту попытку уже нельзя перебросить.', 'attempt_locked');
  await ensureNoActiveVerification(current.id, env);
  const pool = await getPool(env, ctx);
  const excludedHeroIds = await recentHeroIds(user.steam_id, env);
  const roll = current.build_style === 'pro'
    ? await createProRoll(pool, current.mode, env, excludedHeroIds)
    : createRoll(pool, current.mode, current.order_required === 1, excludedHeroIds);
  const now = nowSeconds();
  const result = await env.DB.prepare(`UPDATE attempts SET roll_count = roll_count + 1, seed = ?, hero_id = ?, hero_key = ?,
    hero_name = ?, items_json = ?, modifier_id = ?, rules_version = ?, data_version = ?, committed_at = ?, verification_retry_at = 0,
    position = ?, starting_items_json = ?, source_match_id = ?, source_player = ?, sample_count = ?, updated_at = ?
    WHERE id = ? AND status = 'committed' AND roll_count = ?`)
    .bind(roll.seed, roll.hero.id, roll.hero.key, roll.hero.name, JSON.stringify(roll.items), roll.modifier.id, RULES_VERSION,
      'dataVersion' in roll ? String(roll.dataVersion) : pool.generatedAt, now,
      'position' in roll ? roll.position : null, JSON.stringify('startingItems' in roll ? roll.startingItems : []),
      'sourceMatchId' in roll ? roll.sourceMatchId : null, 'sourcePlayer' in roll ? roll.sourcePlayer : null,
      'sampleCount' in roll ? roll.sampleCount : 0, now, id, current.roll_count).run();
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
  await ensureNoActiveVerification(current.id, env);
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

async function handleDefer(id: string, request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const current = await getAttempt(id, user.steam_id, env);
  if (current.status !== 'committed') throw new HttpError(409, 'Эту попытку уже нельзя отложить.', 'defer_conflict');
  await ensureNoActiveVerification(current.id, env);
  const now = nowSeconds();
  const deferred = await env.DB.prepare(`UPDATE attempts SET status = 'expired', deferred_at = ?, updated_at = ?
    WHERE id = ? AND steam_id = ? AND status = 'committed'`)
    .bind(now, now, current.id, user.steam_id).run();
  if (deferred.meta.changes !== 1) throw new HttpError(409, 'Попытка уже изменилась в другой вкладке.', 'defer_conflict');
  return json({ attemptId: current.id, status: 'awaiting_match_id', mode: current.mode,
    heroName: current.hero_name, updatedAt: now }, 200, env);
}

async function handleSubmit(id: string, request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const attempt = await getAttempt(id, user.steam_id, env);
  const latest = await latestVerificationJob(attempt.id, env);
  const canRetry = attempt.status === 'expired' && latest && canRetryVerificationJob(latest);
  if ((!canSubmitAttempt(attempt) && !canRetry) || !attempt.committed_at) {
    throw new HttpError(409, 'Ranked-попытка не активна.', 'attempt_not_committed');
  }
  const body = await readJson(request);
  const matchId = typeof body.matchId === 'string' ? body.matchId.trim() : String(body.matchId || '');
  if (!/^\d{8,12}$/.test(matchId)) throw new HttpError(400, 'Введите корректный match ID.', 'invalid_match_id');

  const existing = await activeVerificationJob(attempt.id, env);
  if (existing) return json(verificationJobPayload(existing, attempt), 202, env);
  await claimVerificationRequest(attempt.id, user.steam_id, env);

  const now = nowSeconds();
  const job: VerificationJobRow = {
    id: crypto.randomUUID(),
    attempt_id: attempt.id,
    attempt_updated_at: now,
    steam_id: user.steam_id,
    match_id: matchId,
    status: 'queued',
    message: 'Матч поставлен в очередь GitHub Actions.',
    result_json: null,
    created_at: now,
    updated_at: now,
    expires_at: now + VERIFICATION_JOB_SECONDS
  };

  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO verification_jobs
        (id, attempt_id, attempt_updated_at, steam_id, match_id, status, message, result_json, created_at, updated_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`)
        .bind(job.id, job.attempt_id, job.attempt_updated_at, job.steam_id, job.match_id, job.status, job.message,
          job.created_at, job.updated_at, job.expires_at),
      env.DB.prepare(`UPDATE attempts SET status = 'expired', deferred_at = 0, updated_at = ?
        WHERE id = ? AND status IN ('committed', 'expired') AND updated_at = ?`)
        .bind(now, attempt.id, attempt.updated_at),
      env.DB.prepare('DELETE FROM verification_jobs WHERE expires_at <= ?').bind(now)
    ]);
  } catch (error) {
    const concurrent = await activeVerificationJob(attempt.id, env);
    if (concurrent) return json(verificationJobPayload(concurrent, attempt), 202, env);
    throw error;
  }

  try {
    await dispatchVerificationJob(job, { ...attempt, status: 'expired', updated_at: now }, user.account_id, env);
  } catch (error) {
    await env.DB.batch([
      env.DB.prepare("UPDATE verification_jobs SET status = 'retry', message = ?, updated_at = ? WHERE id = ?")
        .bind('Не удалось запустить проверку. Повторим автоматически.', nowSeconds(), job.id),
      env.DB.prepare('UPDATE attempts SET verification_retry_at = ? WHERE id = ?').bind(nowSeconds() + 60, attempt.id)
    ]);
    job.status = 'retry';
    job.message = 'Не удалось запустить проверку. Повторим автоматически.';
  }

  return json(verificationJobPayload(job, attempt), 202, env);
}

async function handleLeaderboard(url: URL, env: Env): Promise<Response> {
  const mode = url.searchParams.get('mode') === 'turbo' ? 'turbo' : 'normal';
  const buildStyle = url.searchParams.get('style') === 'pro' ? 'pro' : 'chaos';
  const { results } = await env.DB.prepare(`
    WITH ranked AS (
      SELECT submissions.*, ROW_NUMBER() OVER (PARTITION BY steam_id ORDER BY score DESC, verified_at ASC) AS run_rank
      FROM submissions WHERE mode = ? AND build_style = ?
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
  `).bind(mode, buildStyle).all();
  return json({ mode, buildStyle, entries: results }, 200, env);
}

async function handleStats(request: Request, url: URL, env: Env): Promise<Response> {
  const mode = url.searchParams.get('mode') === 'turbo' ? 'turbo' : 'normal';
  const buildStyle = url.searchParams.get('style') === 'pro' ? 'pro' : 'chaos';
  const user = await getUser(request, env);
  const [summary, recent, personal] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS verifiedWins, COUNT(DISTINCT steam_id) AS players,
      COALESCE(ROUND(AVG(score)), 0) AS averageScore,
      COALESCE(ROUND(100.0 * SUM(CASE WHEN completion_items >= completion_total THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0)), 0) AS fullBuildRate
      FROM submissions WHERE mode = ? AND build_style = ?`).bind(mode, buildStyle).first(),
    env.DB.prepare(`SELECT users.display_name AS displayName, users.avatar_url AS avatarUrl,
      submissions.score, submissions.completion_items AS completedItems,
      submissions.completion_total AS totalItems, submissions.modifier_id AS modifierId,
      submissions.verified_at AS verifiedAt
      FROM submissions JOIN users ON users.steam_id = submissions.steam_id
      WHERE submissions.mode = ? AND submissions.build_style = ? ORDER BY submissions.verified_at DESC LIMIT 8`).bind(mode, buildStyle).all(),
    user ? env.DB.prepare(`WITH ranked AS (
        SELECT submissions.*, ROW_NUMBER() OVER (PARTITION BY steam_id ORDER BY score DESC, verified_at ASC) AS runRank
        FROM submissions WHERE mode = ? AND build_style = ?
      ), totals AS (
        SELECT steam_id, SUM(score) AS score, COUNT(*) AS verifiedWins, MAX(score) AS bestScore,
          SUM(rerolls + cancel_penalties) AS totalPenalties, MIN(verified_at) AS firstVerified
        FROM ranked WHERE runRank <= 10 GROUP BY steam_id
      ), standings AS (
        SELECT totals.*, ROW_NUMBER() OVER (ORDER BY score DESC, totalPenalties ASC, firstVerified ASC) AS place
        FROM totals
      )
      SELECT place, score, verifiedWins, bestScore, totalPenalties FROM standings WHERE steam_id = ?`)
      .bind(mode, buildStyle, user.steam_id).first() : Promise.resolve(null)
  ]);
  return json({ mode, buildStyle, summary, recent: recent.results, personal }, 200, env);
}

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env) });
  if (request.method === 'POST' && url.pathname === '/internal/stratz-match') {
    return handleStratzMatch(request, env);
  }
  if (request.method === 'POST' && url.pathname === '/internal/verification-callback') {
    return handleVerificationCallback(request, env);
  }
  if (request.method === 'GET' && url.pathname === '/health') {
    const verifierEnv = env as Env & {
      GITHUB_ACTIONS_TOKEN?: string;
      VERIFICATION_CALLBACK_SECRET?: string;
      STRATZ_API_TOKEN?: string;
    };
    return json({
      ok: true, rulesVersion: RULES_VERSION, cancelPenalty: CANCEL_PENALTY_ROLLS, matchGuardSeconds: MATCH_GUARD_SECONDS,
      verificationCooldownSeconds: VERIFICATION_REQUEST_COOLDOWN_SECONDS,
      providers: {
        githubActions: Boolean(verifierEnv.GITHUB_ACTIONS_TOKEN && verifierEnv.VERIFICATION_CALLBACK_SECRET),
        directOpenDota: false,
        stratzFallback: Boolean(verifierEnv.STRATZ_API_TOKEN)
      }
    }, 200, env);
  }
  if (request.method === 'GET' && url.pathname === '/auth/steam') return handleSteamLogin(url, env);
  if (request.method === 'GET' && url.pathname === '/auth/steam/callback') return handleSteamCallback(request, url, env);
  if (request.method === 'POST' && url.pathname === '/auth/exchange') return handleExchange(request, env);
  if (request.method === 'GET' && url.pathname === '/me') return json({ user: await getUser(request, env) }, 200, env);
  if (request.method === 'GET' && url.pathname === '/leaderboard') return handleLeaderboard(url, env);
  if (request.method === 'GET' && url.pathname === '/pro-builds/status') {
    const { results } = await env.DB.prepare(`SELECT mode, COUNT(*) AS builds, COUNT(DISTINCT hero_id) AS heroes,
      MAX(observed_at) AS updatedAt FROM pro_build_samples WHERE observed_at >= ? GROUP BY mode`)
      .bind(nowSeconds() - PRO_SAMPLE_MAX_AGE).all();
    return json({ modes: results }, 200, env);
  }
  if (request.method === 'GET' && url.pathname === '/stats') return handleStats(request, url, env);
  if (request.method === 'GET' && url.pathname === '/verification-queue') return handleVerificationQueue(request, env);
  if (request.method === 'GET' && url.pathname === '/attempts/active') {
    const user = await requireUser(request, env);
    let active = await env.DB.prepare(`SELECT * FROM attempts WHERE steam_id = ? AND status IN ('rolling', 'committed')
      AND created_at > ? AND NOT EXISTS (SELECT 1 FROM verification_jobs
        WHERE verification_jobs.attempt_id = attempts.id AND verification_jobs.status IN ('queued', 'running', 'retry'))
      ORDER BY created_at DESC LIMIT 1`).bind(user.steam_id, nowSeconds() - ATTEMPT_SECONDS).first<AttemptRow>();
    if (active?.status === 'rolling') {
      const now = nowSeconds();
      await env.DB.prepare("UPDATE attempts SET status = 'committed', committed_at = ?, updated_at = ? WHERE id = ? AND status = 'rolling'")
        .bind(now, now, active.id).run();
      active = await getAttempt(active.id, user.steam_id, env);
    }
    return json({ attempt: active ? challenge(active) : null }, 200, env);
  }
  if (request.method === 'POST' && url.pathname === '/attempts') return handleCreateAttempt(request, env, ctx);

  const verificationMatch = url.pathname.match(/^\/attempts\/([0-9a-f-]+)\/verification$/i);
  if (request.method === 'GET' && verificationMatch) {
    return handleVerificationStatus(verificationMatch[1], request, env);
  }

  const match = url.pathname.match(/^\/attempts\/([0-9a-f-]+)\/(reroll|commit|cancel|defer|submit)$/i);
  if (request.method === 'POST' && match) {
    if (match[2] === 'reroll') return handleReroll(match[1], request, env, ctx);
    if (match[2] === 'commit') return handleCommit(match[1], request, env);
    if (match[2] === 'cancel') return handleCancel(match[1], request, env);
    if (match[2] === 'defer') return handleDefer(match[1], request, env);
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
  },
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await processVerificationQueue(env);
    if (controller.cron === '*/10 * * * *' || controller.cron === '17 3 * * *') {
      try {
        const dailyRefresh = controller.cron === '17 3 * * *';
        const hourlyCatchUp = new Date(controller.scheduledTime).getUTCMinutes() === 0 && await proPoolNeedsCoverage(env);
        await processProBuildRefresh(env, dailyRefresh || hourlyCatchUp);
      } catch (error) {
        console.error(JSON.stringify({ message: 'pro-build refresh failed', error: error instanceof Error ? error.message : String(error) }));
      }
    }
  }
} satisfies ExportedHandler<Env>;
