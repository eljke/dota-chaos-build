const AGHANIMS_SCEPTER_ID = 108;
const AGHANIMS_SHARD_ID = 609;
const SMOKE_OF_DECEIT_ID = 188;

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function eventItemId(event) {
  return number(event?.itemId ?? event?.item_id ?? event?.id, -1);
}

function countItem(events, itemId) {
  return array(events).reduce((total, event) => total + (eventItemId(event) === itemId ? number(event?.count, 1) : 0), 0);
}

function secondsUntilNextUtcDay(now) {
  const date = new Date(now * 1000);
  const reset = Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1) / 1000) + 5;
  return Math.max(60, Math.min(24 * 60 * 60, reset - now));
}

export function normalizeStratzMatch(payload) {
  const match = payload?.data?.match;
  if (!match || !Array.isArray(match.players)) return null;

  const runeEvents = array(match.playbackData?.runeEvents);
  const players = match.players.map((player, playerIndex) => {
    const hasPurchaseLog = Array.isArray(player?.stats?.itemPurchases);
    const itemPurchases = array(player?.stats?.itemPurchases)
      .filter(event => Number.isFinite(Number(event?.itemId)))
      .map(event => ({ id: number(event.itemId), item_id: number(event.itemId), time: number(event.time) }))
      .sort((left, right) => left.time - right.time);
    const itemUsed = array(player?.stats?.itemUsed);
    const campStack = array(player?.stats?.campStack).reduce((total, value) => total + number(value), 0);
    const wardsPlaced = array(player?.stats?.wards).length;
    const playerSlot = number(player?.playerSlot);
    const runePickups = runeEvents.filter(event => {
      const source = number(event?.fromPlayer, -1);
      return source === playerIndex || source === playerSlot;
    }).length;

    return {
      account_id: number(player?.steamAccountId),
      player_slot: playerSlot,
      hero_id: number(player?.heroId),
      win: player?.isVictory === true ? 1 : 0,
      leaver_status: number(player?.leaverStatus),
      kills: number(player?.kills),
      deaths: number(player?.deaths),
      assists: number(player?.assists),
      tower_damage: number(player?.towerDamage),
      item_0: number(player?.item0Id),
      item_1: number(player?.item1Id),
      item_2: number(player?.item2Id),
      item_3: number(player?.item3Id),
      item_4: number(player?.item4Id),
      item_5: number(player?.item5Id),
      backpack_0: number(player?.backpack0Id),
      backpack_1: number(player?.backpack1Id),
      backpack_2: number(player?.backpack2Id),
      purchase_log: hasPurchaseLog ? itemPurchases : undefined,
      buyback_count: array(player?.playbackData?.buyBackEvents).length,
      rune_pickups: runePickups,
      camps_stacked: campStack,
      obs_placed: wardsPlaced,
      sen_placed: 0,
      purchase_by_id: {
        [AGHANIMS_SCEPTER_ID]: countItem(itemPurchases, AGHANIMS_SCEPTER_ID),
        [AGHANIMS_SHARD_ID]: countItem(itemPurchases, AGHANIMS_SHARD_ID),
        [SMOKE_OF_DECEIT_ID]: countItem(itemPurchases, SMOKE_OF_DECEIT_ID)
      },
      item_uses_by_id: {
        [SMOKE_OF_DECEIT_ID]: countItem(itemUsed, SMOKE_OF_DECEIT_ID)
      }
    };
  });

  const hasParsedData = players.some(player => Array.isArray(player.purchase_log));

  return {
    match_id: number(match.id),
    radiant_win: match.didRadiantWin === true,
    duration: number(match.durationSeconds),
    start_time: number(match.startDateTime),
    lobby_type: number(match.lobbyType),
    game_mode: number(match.gameMode),
    radiant_score: number(match.radiantKills),
    dire_score: number(match.direKills),
    players,
    od_data: { has_parsed: hasParsedData },
    ranked_data_source: 'stratz'
  };
}

export function openDotaRateLimit(body, headers = {}, now = Math.floor(Date.now() / 1000)) {
  const text = String(body || '').toLowerCase();
  const retryHeader = Number(headers.retryAfter || headers['retry-after']);
  const daily = text.includes('daily');
  const headerSeconds = Number.isFinite(retryHeader) && retryHeader > 0 ? Math.ceil(retryHeader) : 0;
  const retryAfter = daily
    ? Math.max(headerSeconds, secondsUntilNextUtcDay(now))
    : headerSeconds || 60;
  return {
    kind: daily ? 'daily' : 'minute',
    retryAfter,
    blockedUntil: now + retryAfter,
    message: daily
      ? 'OpenDota исчерпала суточный лимит для текущего IP Cloudflare. Пробуем резервный источник.'
      : 'OpenDota временно ограничила частоту запросов. Пробуем резервный источник.'
  };
}
