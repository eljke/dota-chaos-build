import process from 'node:process';
import { verifyMatch } from '../worker/src/verify.js';
import { signVerificationPayload } from '../worker/src/verification-auth.js';

const OPENDOTA_API = 'https://api.opendota.com/api';
const USER_AGENT = 'dota-chaos-ranked-verifier/1.7.0 (+https://github.com/eljke/dota-chaos-build)';
const POLL_DELAYS_MS = [15_000, 30_000, 60_000, 90_000, 120_000];

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

async function callback(payload) {
  const body = JSON.stringify({ jobId, matchId, ...payload });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await signVerificationPayload(callbackSecret, timestamp, body);
  let lastError;

  for (let attemptNumber = 1; attemptNumber <= 3; attemptNumber += 1) {
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
      if (response.ok) return;
      lastError = new Error(`Callback returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
    } catch (error) {
      lastError = error;
    }
    if (attemptNumber < 3) await sleep(attemptNumber * 3000);
  }

  throw lastError || new Error('Callback failed.');
}

function retryAfterFromResponse(response, body) {
  const header = Number(response.headers.get('retry-after') || 0);
  if (header > 0) return Math.min(3600, Math.ceil(header));
  return /daily/i.test(body) ? 1800 : 300;
}

async function openDota(path, options = {}) {
  const response = await fetch(`${OPENDOTA_API}${path}`, {
    ...options,
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, ...(options.headers || {}) }
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
  return response;
}

async function fetchMatch() {
  const response = await openDota(`/matches/${matchId}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new RetryableProviderError(`OpenDota вернула HTTP ${response.status}.`, 300);
  const match = await response.json().catch(() => null);
  if (!match || typeof match !== 'object') throw new RetryableProviderError('OpenDota вернула некорректный JSON.', 300);
  return match;
}

async function requestParse() {
  const response = await openDota(`/request/${matchId}`, { method: 'POST' });
  if (![200, 202, 409].includes(response.status)) {
    throw new RetryableProviderError(`OpenDota не приняла запрос разбора: HTTP ${response.status}.`, 300);
  }
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
  let match = await fetchMatch();
  if (match) {
    const basicProof = verifyMatch({ match, attempt, accountId });
    if (basicProof.parsed) return match;
  }

  await requestParse();
  for (const delay of POLL_DELAYS_MS) {
    await sleep(delay);
    match = await fetchMatch();
    if (!match) continue;
    const proof = verifyMatch({ match, attempt, accountId });
    if (proof.parsed) return match;
  }

  throw new RetryableProviderError('OpenDota ещё не закончила разбор реплея.', 300);
}

await callback({ status: 'running', message: 'GitHub Actions получила задачу проверки.' });

try {
  const match = await obtainVerifiableMatch();
  await callback({
    status: 'completed',
    source: 'github-actions-opendota',
    match: compactMatch(match)
  });
} catch (error) {
  const retryable = error instanceof RetryableProviderError;
  await callback({
    status: retryable ? 'retry' : 'error',
    message: error instanceof Error ? error.message : String(error),
    retryAfter: retryable ? error.retryAfter : 300
  });
  if (!retryable) throw error;
}
