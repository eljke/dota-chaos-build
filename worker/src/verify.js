import { modifierById } from '../../js/modifiers.js';

const NORMAL_GAME_MODES = new Set([1, 2, 3, 4, 5, 12, 16, 17, 22]);
const PUBLIC_LOBBIES = new Set([0, 5, 6, 7, 9]);
const MISSING_ITEM_FACTOR = 0.6;

function numericSet(values) {
  return new Set((Array.isArray(values) ? values : []).map(Number).filter(Number.isFinite));
}

function stringSet(values) {
  return new Set((Array.isArray(values) ? values : [])
    .filter(value => typeof value === 'string' && value.length > 0)
    .map(String));
}


function itemCandidateIds(item) {
  return numericSet([item?.id, ...(Array.isArray(item?.upgradeIds) ? item.upgradeIds : [])]);
}

function itemCandidateKeys(item) {
  return stringSet([
    item?.key,
    item?.sourceKey,
    ...(Array.isArray(item?.upgradeKeys) ? item.upgradeKeys : [])
  ]);
}

function entryMatchesItem(entry, item) {
  const ids = itemCandidateIds(item);
  const keys = itemCandidateKeys(item);
  return keys.has(String(entry?.key || '')) || ids.has(Number(entry?.id ?? entry?.item_id));
}

function firstPurchaseIndex(purchaseLog, item) {
  return purchaseLog.findIndex(entry => entryMatchesItem(entry, item));
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

function finalItemAssignment(items, finalIds) {
  const slotOwner = Array(finalIds.length).fill(-1);
  const assignedSlot = Array(items.length).fill(-1);
  const candidates = items.map(item => {
    const ids = itemCandidateIds(item);
    return finalIds
      .map((id, slot) => ({ id, slot, exact: Number(id) === Number(item?.id) }))
      .filter(entry => entry.id > 0 && ids.has(entry.id))
      .sort((a, b) => Number(b.exact) - Number(a.exact));
  });

  const order = items
    .map((_, index) => index)
    .sort((a, b) => candidates[a].length - candidates[b].length);

  function assign(itemIndex, seenSlots) {
    for (const candidate of candidates[itemIndex]) {
      if (seenSlots.has(candidate.slot)) continue;
      seenSlots.add(candidate.slot);
      const previousOwner = slotOwner[candidate.slot];
      if (previousOwner === -1 || assign(previousOwner, seenSlots)) {
        slotOwner[candidate.slot] = itemIndex;
        assignedSlot[itemIndex] = candidate.slot;
        return true;
      }
    }
    return false;
  }

  for (const itemIndex of order) assign(itemIndex, new Set());
  return assignedSlot;
}

export function completionMultiplier(completedItems, totalItems = 6) {
  const total = Math.max(1, Number(totalItems) || 1);
  const completed = Math.max(0, Math.min(total, Number(completedItems) || 0));
  if (completed === 0) return 0;
  return MISSING_ITEM_FACTOR ** (total - completed);
}

export function calculateScore({
  rerolls,
  cancelPenalties = 0,
  orderRequired,
  modifierMultiplier = 1,
  completedItems = 6,
  totalItems = 6
}) {
  const orderMultiplier = orderRequired ? 1.2 : 1;
  const penaltyDivisor = Number(rerolls) + Number(cancelPenalties) + 1;
  const buildMultiplier = completionMultiplier(completedItems, totalItems);
  return Math.round(1000 * modifierMultiplier * orderMultiplier * buildMultiplier / penaltyDivisor);
}

export function verifyModifier({ modifierId, match, player, attempt }) {
  const modifier = modifierById(modifierId);
  if (!modifier) return { ok: !modifierId, code: modifierId ? 'unknown_modifier' : null, error: modifierId ? 'Неизвестный ranked-модификатор.' : null, evidence: null };

  const turbo = attempt.mode === 'turbo';
  const log = Array.isArray(player.purchase_log) ? player.purchase_log : [];
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
      const luxury = Math.min(...attempt.items
        .filter(item => Number(item.cost) >= 5000)
        .map(item => firstPurchaseIndex(log, item))
        .filter(index => index >= 0));
      value = { shard, firstLuxury: luxury };
      ok = shard >= 0 && Number.isFinite(luxury) && shard < luxury;
      break;
    }
  }

  return {
    ok,
    code: ok ? null : 'modifier_failed',
    error: ok ? null : `Не выполнен модификатор «${modifier.name}»: ${modifier.description}`,
    evidence: { id: modifier.id, value }
  };
}

export function verifyMatch({ match, attempt, accountId }) {
  const errors = [];
  const errorCodes = [];
  const fail = (code, message) => { errorCodes.push(code); errors.push(message); };
  const players = Array.isArray(match?.players) ? match.players : [];
  const player = players.find(candidate => Number(candidate?.account_id) === Number(accountId));

  if (!player) return { ok: false, parsed: true, errorCodes: ['player_not_found'], errors: ['В матче не найден авторизованный Steam-аккаунт.'] };

  if (!PUBLIC_LOBBIES.has(Number(match.lobby_type))) fail('public_match_required', 'Допускаются только публичные матчи без ботов.');
  const isTurbo = Number(match.game_mode) === 23;
  if (attempt.mode === 'turbo' ? !isTurbo : !NORMAL_GAME_MODES.has(Number(match.game_mode))) {
    fail('wrong_mode', `Матч не соответствует режиму ${attempt.mode === 'turbo' ? 'Turbo' : 'Normal'}.`);
  }
  if (Number(player.hero_id) !== Number(attempt.hero_id)) fail('wrong_hero', 'Сыгран не выданный герой.');
  if (Number(player.win) !== 1) fail('not_a_win', 'Матч не завершён победой.');
  if (Number(player.leaver_status) !== 0) fail('abandon', 'Матч содержит abandon или ранний выход.');

  const guardSeconds = Number(attempt.match_guard_seconds || 0);
  const eligibleAfter = Number(attempt.committed_at) + guardSeconds;
  if (!Number.isFinite(eligibleAfter) || Number(match.start_time) < eligibleAfter) {
    fail('started_too_early', `Матч начался слишком рано: ranked-сборка должна быть выдана минимум за ${Math.ceil(guardSeconds / 60)} мин. до старта.`);
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
  if (errors.length) return { ok: false, parsed: true, errorCodes, errors, player, evidence: basicEvidence };
  if (!Array.isArray(player.purchase_log)) {
    return { ok: false, parsed: false, errorCodes: ['purchase_log_pending'], errors: ['Данные матча ещё не содержат журнал покупок.'], player, evidence: basicEvidence };
  }

  const items = Array.isArray(attempt.items) ? attempt.items : [];
  const purchaseLog = player.purchase_log;
  const purchaseIndices = items.map(item => firstPurchaseIndex(purchaseLog, item));
  const finalIds = [
    player.item_0, player.item_1, player.item_2, player.item_3, player.item_4, player.item_5,
    player.backpack_0, player.backpack_1, player.backpack_2
  ].map(Number);
  const assignedSlots = finalItemAssignment(items, finalIds);
  const matchedItems = items.map((item, index) => ({
    id: Number(item.id),
    name: item.name,
    purchaseIndex: purchaseIndices[index],
    finalSlot: assignedSlots[index],
    finalItemId: assignedSlots[index] >= 0 ? finalIds[assignedSlots[index]] : null,
    upgraded: assignedSlots[index] >= 0 && finalIds[assignedSlots[index]] !== Number(item.id),
    matched: purchaseIndices[index] >= 0 && assignedSlots[index] >= 0
  }));
  const completedItems = matchedItems.filter(item => item.matched).length;

  if (completedItems === 0) fail('no_build_items', 'Не подтверждён ни один предмет из выданной сборки.');

  if (attempt.order_required) {
    let previousIndex = -1;
    for (const item of matchedItems) {
      if (!item.matched) continue;
      if (item.purchaseIndex <= previousIndex) {
        fail('wrong_item_order', 'Подтверждённые предметы завершены не в выданном порядке.');
        break;
      }
      previousIndex = item.purchaseIndex;
    }
  }

  const modifierProof = verifyModifier({ modifierId: attempt.modifier_id, match, player, attempt });
  if (!modifierProof.ok && modifierProof.error) fail(modifierProof.code || 'modifier_failed', modifierProof.error);

  const totalItems = items.length || 6;
  return {
    ok: errors.length === 0,
    parsed: true,
    errorCodes,
    errors,
    player,
    completedItems,
    totalItems,
    completionMultiplier: completionMultiplier(completedItems, totalItems),
    evidence: {
      ...basicEvidence,
      completedItems,
      totalItems,
      completionMultiplier: completionMultiplier(completedItems, totalItems),
      matchedItems,
      missingItems: matchedItems.filter(item => !item.matched).map(item => ({ id: item.id, name: item.name })),
      finalItemIds: finalIds,
      modifier: modifierProof.evidence
    }
  };
}
