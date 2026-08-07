import { modifierById } from '../../js/modifiers.js';

const NORMAL_GAME_MODES = new Set([1, 2, 3, 4, 5, 12, 16, 17, 22]);
const PUBLIC_LOBBIES = new Set([0, 5, 6, 7, 9]);

function firstPurchaseIndex(purchaseLog, item) {
  return purchaseLog.findIndex(entry =>
    entry?.key === item.key
    || entry?.key === item.sourceKey
    || Number(entry?.id ?? entry?.item_id) === Number(item.id)
  );
}

function countById(record, id) {
  return Number(record?.[id] ?? record?.[String(id)] ?? 0);
}

function purchaseCount(player, key, id) {
  const named = Number(player.purchase?.[key] || 0);
  if (named > 0) return named;
  const byId = countById(player.purchase_by_id, id);
  if (byId > 0) return byId;
  return (Array.isArray(player.purchase_log) ? player.purchase_log : [])
    .filter(entry => entry?.key === key || Number(entry?.id ?? entry?.item_id) === Number(id)).length;
}

function useCount(player, key, id) {
  return Number(player.item_uses?.[key] || 0) || countById(player.item_uses_by_id, id);
}

export function calculateScore({ rerolls, cancelPenalties = 0, orderRequired, modifierMultiplier = 1 }) {
  const orderMultiplier = orderRequired ? 1.2 : 1;
  const penaltyDivisor = Number(rerolls) + Number(cancelPenalties) + 1;
  return Math.round(1000 * modifierMultiplier * orderMultiplier / penaltyDivisor);
}

export function verifyModifier({ modifierId, match, player, attempt }) {
  const modifier = modifierById(modifierId);
  if (!modifier) return { ok: !modifierId, error: modifierId ? 'Неизвестный ranked-модификатор.' : null, evidence: null };

  const turbo = attempt.mode === 'turbo';
  const purchases = player.purchase || {};
  const uses = player.item_uses || {};
  const log = player.purchase_log;
  const teamKills = Number(player.player_slot) < 128 ? Number(match.radiant_score) : Number(match.dire_score);
  const participation = teamKills > 0 ? (Number(player.kills) + Number(player.assists)) / teamKills : 0;
  const kda = (Number(player.kills) + Number(player.assists)) / Math.max(1, Number(player.deaths));
  let ok = false;
  let value;

  switch (modifier.id) {
    case 'no-buyback': value = Number(player.buyback_count || 0); ok = value === 0; break;
    case 'teamfight': value = participation; ok = value >= 0.5; break;
    case 'tower-pressure': value = Number(player.tower_damage || 0); ok = value >= (turbo ? 2000 : 3000); break;
    case 'rune-control': value = Number(player.rune_pickups || 0); ok = value >= (turbo ? 4 : 6); break;
    case 'clean-kda': value = { kda, participation }; ok = kda >= 4 && participation >= 0.35; break;
    case 'camp-stacker': value = Number(player.camps_stacked || 0); ok = value >= (turbo ? 2 : 3); break;
    case 'vision': value = Number(player.obs_placed || 0) + Number(player.sen_placed || 0); ok = value >= (turbo ? 6 : 8); break;
    case 'smoke-operation': {
      value = { purchased: purchaseCount(player, 'smoke_of_deceit', 188), used: useCount(player, 'smoke_of_deceit', 188) };
      const target = turbo ? 1 : 2;
      ok = value.purchased >= target && value.used >= target;
      break;
    }
    case 'aghanim-early': {
      const aghanim = log.findIndex(entry => entry?.key === 'ultimate_scepter' || Number(entry?.id ?? entry?.item_id) === 108);
      const thirdItem = firstPurchaseIndex(log, attempt.items[2]);
      value = { aghanim, thirdItem };
      ok = aghanim >= 0 && thirdItem >= 0 && aghanim < thirdItem;
      break;
    }
    case 'shard-before-luxury': {
      const shard = log.findIndex(entry => entry?.key === 'aghanims_shard' || Number(entry?.id ?? entry?.item_id) === 609);
      const luxury = Math.min(...attempt.items.filter(item => Number(item.cost) >= 5000).map(item => firstPurchaseIndex(log, item)).filter(index => index >= 0));
      value = { shard, firstLuxury: luxury };
      ok = shard >= 0 && Number.isFinite(luxury) && shard < luxury;
      break;
    }
  }

  return { ok, error: ok ? null : `Не выполнен модификатор «${modifier.name}»: ${modifier.description}`, evidence: { id: modifier.id, value } };
}

export function verifyMatch({ match, attempt, accountId }) {
  const errors = [];
  const players = Array.isArray(match?.players) ? match.players : [];
  const player = players.find(candidate => Number(candidate?.account_id) === Number(accountId));

  if (!player) return { ok: false, parsed: true, errors: ['В матче не найден авторизованный Steam-аккаунт.'] };

  if (!PUBLIC_LOBBIES.has(Number(match.lobby_type))) errors.push('Допускаются только публичные матчи без ботов.');
  const isTurbo = Number(match.game_mode) === 23;
  if (attempt.mode === 'turbo' ? !isTurbo : !NORMAL_GAME_MODES.has(Number(match.game_mode))) {
    errors.push(`Матч не соответствует режиму ${attempt.mode === 'turbo' ? 'Turbo' : 'Normal'}.`);
  }
  if (Number(player.hero_id) !== Number(attempt.hero_id)) errors.push('Сыгран не выданный герой.');
  if (Number(player.win) !== 1) errors.push('Матч не завершён победой.');
  if (Number(player.leaver_status) !== 0) errors.push('Матч содержит abandon или ранний выход.');

  const guardSeconds = Number(attempt.match_guard_seconds || 0);
  const eligibleAfter = Number(attempt.committed_at) + guardSeconds;
  if (!Number.isFinite(eligibleAfter) || Number(match.start_time) < eligibleAfter) {
    errors.push(`Матч начался слишком рано: ranked-сборка должна быть выдана минимум за ${Math.ceil(guardSeconds / 60)} мин. до старта.`);
  }

  const basicEvidence = {
    heroId: Number(player.hero_id),
    duration: Number(match.duration),
    gameMode: Number(match.game_mode),
    lobbyType: Number(match.lobby_type),
    committedAt: Number(attempt.committed_at),
    eligibleAfter
  };

  // Basic match data is enough to reject a wrong hero, loss or invalid start time.
  // Do not spend a replay-parse request on a match that can never pass verification.
  if (errors.length) return { ok: false, parsed: true, errors, player, evidence: basicEvidence };
  if (!Array.isArray(player.purchase_log)) {
    return { ok: false, parsed: false, errors: ['Данные матча ещё не содержат журнал покупок.'], player, evidence: basicEvidence };
  }

  const purchaseLog = player.purchase_log;
  const purchaseIndices = attempt.items.map(item => firstPurchaseIndex(purchaseLog, item));
  const finalIds = [
    player.item_0, player.item_1, player.item_2, player.item_3, player.item_4, player.item_5,
    player.backpack_0, player.backpack_1, player.backpack_2
  ].map(Number);

  attempt.items.forEach((item, index) => {
    if (purchaseIndices[index] < 0) errors.push(`Не подтверждена покупка ${item.name}.`);
    if (!finalIds.includes(Number(item.id))) errors.push(`${item.name} отсутствует в финальном инвентаре или backpack.`);
  });

  const purchases = new Set(purchaseLog.map(entry => entry?.key));
  const purchaseIds = new Set(purchaseLog.map(entry => Number(entry?.id ?? entry?.item_id)));
  if (!purchases.has('ultimate_scepter') && !purchaseIds.has(108)) errors.push("Не подтверждена покупка Aghanim's Scepter.");
  if (!purchases.has('aghanims_shard') && !purchaseIds.has(609)) errors.push("Не подтверждена покупка Aghanim's Shard.");

  if (attempt.order_required && purchaseIndices.some((value, index) => index > 0 && value <= purchaseIndices[index - 1])) {
    errors.push('Предметы завершены не в выданном порядке.');
  }

  const modifierProof = verifyModifier({ modifierId: attempt.modifier_id, match, player, attempt });
  if (!modifierProof.ok && modifierProof.error) errors.push(modifierProof.error);

  return {
    ok: errors.length === 0,
    parsed: true,
    errors,
    player,
    evidence: {
      ...basicEvidence,
      purchaseIndices,
      finalItemIds: finalIds,
      modifier: modifierProof.evidence
    }
  };
}
