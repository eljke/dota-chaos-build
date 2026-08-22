import process from 'node:process';
import { verifyMatch } from '../worker/src/verify.js';
import { signVerificationPayload } from '../worker/src/verification-auth.js';

const OPENDOTA_API = 'https://api.opendota.com/api';
const USER_AGENT = 'dota-chaos-ranked-verifier/1.7.4 (+https://github.com/eljke/dota-chaos-build)';
const POLL_DELAYS_MS = [15_000, 30_000, 60_000, 90_000, 120_000];
const OPENDOTA_RETRY_DELAYS_MS = [0, 30_000];
const OPENDOTA_TIMEOUT_MS = 35_000;
const OPENDOTA_TRANSIENT_STATUSES = new Set([500, 502, 503, 504, 520, 521, 522, 523, 524]);
const RESPONSE_BODY_LOG_LIMIT = 1_000;

const jobId = String(process.env.INPUT_JOB_ID || '').trim();
const matchId = String(process.env.INPUT_MATCH_ID || '').trim();
const accountId = Number(process.env.INPUT_ACCOUNT_ID || 0);
const callbackUrl = String(process.env.VERIFICATION_CALLBACK_URL || '').trim();
const callbackSecret = String(process.env.VERIFICATION_CALLBACK_SECRET || '').trim();
let attempt;

try {
  attempt = JSON.parse(String(process.env.INPUT_ATTEMPT_PAYLOAD || '{}'));
} catch {
  throw new Error('INPUT_ATTEMPT_PAYLOAD is not valid JSON.');
}

if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw new Error('Invalid job id.');
if (!/^\d{8,12}$/.test(matchId)) throw new Error('Invalid match id.');
if (!Number.isInteger(accountId) || accountId <= 0) throw new Error('Invalid account id.');
if (!/^https:\/\//i.test(callbackUrl)) throw new Error('VERIFICATION_CALLBACK_URL is missing.');
if (callbackSecret.length < 32) throw new Error('VERIFICATION_CALLBACK_SECRET is missing or too short.');

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

class RetryableProviderError extends Error {
  constructor(message, retryAfter = 300) {
    super(message);
    this.retryAfter = retryAfter;
  }
}

function logEvent(scope, event, details = {}) {
  console.log(`[${scope}] ${event} ${JSON.stringify(details)}`);
}

function errorDetails(error) {
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
    cause: error instanceof Error && error.cause
      ? String(error.cause instanceof Error ? error.cause.message : error.cause)
      : undefined
  };
}

function responseHeaders(response) {
  return {
    server: response.headers.get('server') || undefined,
    cfRay: response.headers.get('cf-ray') || undefined,
    cfCacheStatus: response.headers.get('cf-cache-status') || undefined,
    contentType: response.headers.get('content-type') || undefined,
    contentLength: response.headers.get('content-length') || undefined,
    retryAfter: response.headers.get('retry-after') || undefined,
    rateLimitLimit: response.headers.get('x-rate-limit-limit')
      || response.headers.get('x-ratelimit-limit')
      || undefined,
    rateLimitRemaining: response.headers.get('x-rate-limit-remaining')
      || response.headers.get('x-ratelimit-remaining')
      || undefined,
    date: response.headers.get('date') || undefined
  };
}

async function responseBodySnippet(response) {
  const body = await response.clone().text().catch(() => '');
  return body.replace(/\s+/g, ' ').trim().slice(0, RESPONSE_BODY_LOG_LIMIT) || undefined;
}

function responseSuffix(response) {
  const parts = [];
  const cfRay = response.headers.get('cf-ray');
  const server = response.headers.get('server');
  if (cfRay) parts.push(`cf-ray: ${cfRay}`);
  if (server) parts.push(`server: ${server}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

async function fetchStratzMatch() {
  const startedAt = Date.now();
  const endpoint = new URL('/internal/stratz-match', callbackUrl);
  const body = JSON.stringify({ jobId, matchId, accountId });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await signVerificationPayload(callbackSecret, timestamp, body);
  logEvent('stratz', 'proxy_request', { matchId });

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        'X-Verification-Timestamp': timestamp,
        'X-Verification-Signature': signature
      },
      body
    });
  } catch (error) {
    logEvent('stratz', 'network_error', {
      matchId,
      durationMs: Date.now() - startedAt,
      ...errorDetails(error)
    });
    throw new RetryableProviderError(
      `STRATZ-прокси недоступен: ${error instanceof Error ? error.message : String(error)}.`,
      300
    );
  }

  const bodySnippet = response.ok ? undefined : await responseBodySnippet(response);
  logEvent('stratz', 'proxy_response', {
    matchId,
    status: response.status,
    statusText: response.statusText || undefined,
    durationMs: Date.now() - startedAt,
    headers: responseHeaders(response),
    bodySnippet
  });

  if (!response.ok) {
    throw new RetryableProviderError(
      `STRATZ-прокси вернул HTTP ${response.status}${responseSuffix(response)}.`,
      retryAfterFromResponse(response, bodySnippet || '', 300)
    );
  }

  const payload = await response.json().catch(() => null);
  const match = payload && typeof payload === 'object' ? payload.match : null;
  if (!match) {
    logEvent('stratz', 'match_not_found', { matchId });
    return null;
  }

  const parsed = Array.isArray(match.players)
    && match.players.some(player => Array.isArray(player?.purchase_log));
  logEvent('stratz', 'match_loaded', { matchId, parsed, via: 'worker-proxy' });
  return match;
}

async function callback(payload) {
  const body = JSON.stringify({ jobId, matchId, ...payload });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await signVerificationPayload(callbackSecret, timestamp, body);
  let lastError;

  for (let attemptNumber = 1; attemptNumber <= 3; attemptNumber += 1) {
    const startedAt = Date.now();
    logEvent('callback', 'request', { status: payload.status, attempt: attemptNumber });
    try {
      const response = await fetch(callbackUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
          'X-Verification-Timestamp': timestamp,
          'X-Verification-Signature': signature
        },
        body
      });
      logEvent('callback', 'response', {
        status: payload.status,
        attempt: attemptNumber,
        httpStatus: response.status,
        durationMs: Date.now() - startedAt
      });
      if (response.ok) return;
      lastError = new Error(`Callback returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
    } catch (error) {
      lastError = error;
      logEvent('callback', 'network_error', {
        status: payload.status,
        attempt: attemptNumber,
        durationMs: Date.now() - startedAt,
        ...errorDetails(error)
      });
    }
    if (attemptNumber < 3) await sleep(attemptNumber * 3000);
  }

  throw lastError || new Error('Callback failed.');
}

function retryAfterFromResponse(response, body, fallback = 300) {
  const header = Number(response.headers.get('retry-after') || 0);
  if (header > 0) return Math.min(3600, Math.ceil(header));
  return /daily/i.test(body) ? 1800 : fallback;
}

async function openDota(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const url = `${OPENDOTA_API}${path}`;
  const maxAttempts = OPENDOTA_RETRY_DELAYS_MS.length;
  const canUseFastFallback = method === 'GET'
    && path.startsWith('/matches/');
  let nextDelayMs = 0;

  for (let index = 0; index < maxAttempts; index += 1) {
    const attemptNumber = index + 1;
    const delay = index === 0 ? 0 : nextDelayMs || OPENDOTA_RETRY_DELAYS_MS[index];

    if (delay > 0) {
      logEvent('opendota', 'retry_wait', {
        method,
        path,
        attempt: attemptNumber,
        delayMs: delay
      });
      await sleep(delay);
    }

    const startedAt = Date.now();
    logEvent('opendota', 'request', {
      method,
      path,
      attempt: attemptNumber,
      maxAttempts
    });

    let response;
    try {
      response = await fetch(url, {
        ...options,
        signal: options.signal || AbortSignal.timeout(OPENDOTA_TIMEOUT_MS),
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, ...(options.headers || {}) }
      });
    } catch (error) {
      logEvent('opendota', 'network_error', {
        method,
        path,
        attempt: attemptNumber,
        maxAttempts,
        durationMs: Date.now() - startedAt,
        ...errorDetails(error)
      });

      if (attemptNumber < maxAttempts) continue;

      throw new RetryableProviderError(
        `OpenDota недоступна из GitHub Actions: ${error instanceof Error ? error.message : String(error)}.`,
        300
      );
    }

    const transient = OPENDOTA_TRANSIENT_STATUSES.has(response.status);
    logEvent('opendota', 'response', {
      method,
      path,
      attempt: attemptNumber,
      maxAttempts,
      status: response.status,
      statusText: response.statusText || undefined,
      durationMs: Date.now() - startedAt,
      transient,
      headers: responseHeaders(response),
      bodySnippet: response.ok ? undefined : await responseBodySnippet(response)
    });

    if (response.status === 429) {
      const body = await response.text().catch(() => '');
      throw new RetryableProviderError(
        /daily/i.test(body)
          ? 'GitHub runner попал в суточный лимит OpenDota.'
          : 'GitHub runner временно ограничен OpenDota.',
        retryAfterFromResponse(response, body)
      );
    }

    if (!transient || attemptNumber === maxAttempts) return response;

    if (canUseFastFallback) {
      logEvent('opendota', 'switch_provider', {
        method,
        path,
        status: response.status,
        provider: 'stratz'
      });
      return response;
    }

    const configuredDelay = OPENDOTA_RETRY_DELAYS_MS[index + 1] || 30_000;
    const retryAfterMs = retryAfterFromResponse(response, '', 0) * 1000;
    nextDelayMs = Math.max(configuredDelay, retryAfterMs);
  }

  throw new RetryableProviderError('OpenDota временно недоступна.', 300);
}

async function fetchMatch() {
  const response = await openDota(`/matches/${matchId}`);
  if (response.status === 404) return null;
  if (!response.ok) {
    const body = await response.clone().text().catch(() => '');
    throw new RetryableProviderError(
      `OpenDota вернула HTTP ${response.status}${responseSuffix(response)}.`,
      retryAfterFromResponse(response, body, 300)
    );
  }
  const match = await response.json().catch(() => null);
  if (!match || typeof match !== 'object') throw new RetryableProviderError('OpenDota вернула некорректный JSON.', 300);
  return match;
}

async function requestParse() {
  const response = await openDota(`/request/${matchId}`, { method: 'POST' });
  if (![200, 202, 409].includes(response.status)) {
    const body = await response.clone().text().catch(() => '');
    throw new RetryableProviderError(
      `OpenDota не приняла запрос разбора: HTTP ${response.status}${responseSuffix(response)}.`,
      retryAfterFromResponse(response, body, 300)
    );
  }
}

async function fetchMatchWithFallback() {
  let openDotaError = null;
  let openDotaMatch = null;

  try {
    openDotaMatch = await fetchMatch();
    if (openDotaMatch && verifyMatch({ match: openDotaMatch, attempt, accountId }).parsed) return openDotaMatch;
    if (openDotaMatch) logEvent('opendota', 'unparsed', { matchId, fallback: 'worker-stratz-proxy' });
  } catch (error) {
    openDotaError = error;
    logEvent('verification', 'opendota_failed', {
      fallback: 'worker-stratz-proxy',
      ...errorDetails(error)
    });
  }

  try {
    const stratzMatch = await fetchStratzMatch();
    if (stratzMatch) return stratzMatch;
  } catch (stratzError) {
    logEvent('verification', 'stratz_failed', {
      ...errorDetails(stratzError)
    });
    if (openDotaError) {
      const retryAfter = Math.max(
        Number(openDotaError?.retryAfter || 0),
        Number(stratzError?.retryAfter || 0),
        120
      );
      throw new RetryableProviderError(
        `${openDotaError instanceof Error ? openDotaError.message : String(openDotaError)} `
          + `Резервный STRATZ также недоступен: ${stratzError instanceof Error ? stratzError.message : String(stratzError)}`,
        retryAfter
      );
    }
    throw stratzError;
  }

  if (openDotaError) throw openDotaError;
  return openDotaMatch;
}

function compactPlayer(player) {
  if (!player) return null;
  return {
    account_id: player.account_id,
    player_slot: player.player_slot,
    hero_id: player.hero_id,
    win: player.win,
    leaver_status: player.leaver_status,
    kills: player.kills,
    deaths: player.deaths,
    assists: player.assists,
    tower_damage: player.tower_damage,
    buyback_count: player.buyback_count,
    rune_pickups: player.rune_pickups,
    camps_stacked: player.camps_stacked,
    obs_placed: player.obs_placed,
    sen_placed: player.sen_placed,
    purchase: player.purchase,
    purchase_by_id: player.purchase_by_id,
    purchase_log: Array.isArray(player.purchase_log)
      ? player.purchase_log.map(entry => ({ key: entry?.key, id: entry?.id, item_id: entry?.item_id, time: entry?.time }))
      : null,
    item_uses: player.item_uses,
    item_uses_by_id: player.item_uses_by_id,
    item_0: player.item_0,
    item_1: player.item_1,
    item_2: player.item_2,
    item_3: player.item_3,
    item_4: player.item_4,
    item_5: player.item_5,
    backpack_0: player.backpack_0,
    backpack_1: player.backpack_1,
    backpack_2: player.backpack_2
  };
}

function compactMatch(match) {
  const player = Array.isArray(match.players)
    ? match.players.find(candidate => Number(candidate?.account_id) === accountId)
    : null;
  return {
    match_id: match.match_id,
    start_time: match.start_time,
    duration: match.duration,
    game_mode: match.game_mode,
    lobby_type: match.lobby_type,
    radiant_score: match.radiant_score,
    dire_score: match.dire_score,
    players: player ? [compactPlayer(player)] : []
  };
}

async function obtainVerifiableMatch() {
  let match = await fetchMatchWithFallback();
  if (match) {
    const basicProof = verifyMatch({ match, attempt, accountId });
    if (basicProof.parsed) return match;
  }

  if (match?.ranked_data_source === 'stratz') {
    logEvent('verification', 'parse_request_skipped', { provider: 'stratz' });
  } else {
    try {
      await requestParse();
    } catch (error) {
      logEvent('verification', 'parse_request_failed', {
        fallback: 'stratz polling',
        ...errorDetails(error)
      });
    }
  }

  for (const delay of POLL_DELAYS_MS) {
    await sleep(delay);
    match = await fetchMatchWithFallback();
    if (!match) continue;
    const proof = verifyMatch({ match, attempt, accountId });
    if (proof.parsed) return match;
  }

  throw new RetryableProviderError('OpenDota ещё не закончила разбор реплея.', 300);
}

logEvent('verification', 'start', {
  jobId,
  matchId,
  accountId,
  mode: attempt?.mode,
  heroId: attempt?.hero_id
});

await callback({ status: 'running', message: 'GitHub Actions получила задачу проверки.' });

try {
  const match = await obtainVerifiableMatch();
  const source = match?.ranked_data_source === 'stratz'
    ? 'github-actions-stratz'
    : 'github-actions-opendota';
  logEvent('verification', 'completed', {
    matchId,
    source,
    duration: match.duration,
    players: Array.isArray(match.players) ? match.players.length : 0
  });
  await callback({
    status: 'completed',
    source,
    match: compactMatch(match)
  });
} catch (error) {
  const retryable = error instanceof RetryableProviderError;
  logEvent('verification', 'failed', {
    retryable,
    retryAfter: retryable ? error.retryAfter : 300,
    ...errorDetails(error)
  });
  await callback({
    status: retryable ? 'retry' : 'error',
    message: error instanceof Error ? error.message : String(error),
    retryAfter: retryable ? error.retryAfter : 300
  });
  if (!retryable) throw error;
}
