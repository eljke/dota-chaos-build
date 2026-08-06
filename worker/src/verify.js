const NORMAL_GAME_MODES = new Set([1, 2, 3, 4, 5, 12, 16, 17, 22]);
const PUBLIC_LOBBIES = new Set([0, 5, 6, 7, 9]);

function firstPurchaseIndex(purchaseLog, item) {
  return purchaseLog.findIndex(entry => entry?.key === item.key || entry?.key === item.sourceKey);
}

export function calculateScore({ rerolls, orderRequired, modifierMultiplier = 1 }) {
  const orderMultiplier = orderRequired ? 1.2 : 1;
  return Math.round(1000 * modifierMultiplier * orderMultiplier / (rerolls + 1));
}

export function verifyMatch({ match, attempt, accountId }) {
  const errors = [];
  const players = Array.isArray(match?.players) ? match.players : [];
  const player = players.find(candidate => Number(candidate?.account_id) === Number(accountId));

  if (!player) return { ok: false, parsed: true, errors: ['В матче не найден авторизованный Steam-аккаунт.'] };
  if (!Array.isArray(player.purchase_log)) return { ok: false, parsed: false, errors: ['Матч ещё не распарсен OpenDota.'] };

  if (!PUBLIC_LOBBIES.has(Number(match.lobby_type))) errors.push('Допускаются только публичные матчи без ботов.');
  const isTurbo = Number(match.game_mode) === 23;
  if (attempt.mode === 'turbo' ? !isTurbo : !NORMAL_GAME_MODES.has(Number(match.game_mode))) {
    errors.push(`Матч не соответствует режиму ${attempt.mode === 'turbo' ? 'Turbo' : 'Normal'}.`);
  }
  if (Number(player.hero_id) !== Number(attempt.hero_id)) errors.push('Сыгран не выданный герой.');
  if (Number(player.win) !== 1) errors.push('Матч не завершён победой.');
  if (Number(player.leaver_status) !== 0) errors.push('Матч содержит abandon или ранний выход.');
  if (Number(match.start_time) < Number(attempt.committed_at) - 120) errors.push('Матч начался до фиксации ranked-сборки.');

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
  if (!purchases.has('ultimate_scepter')) errors.push("Не подтверждена покупка Aghanim's Scepter.");
  if (!purchases.has('aghanims_shard')) errors.push("Не подтверждена покупка Aghanim's Shard.");

  if (attempt.order_required && purchaseIndices.some((value, index) => index > 0 && value <= purchaseIndices[index - 1])) {
    errors.push('Предметы завершены не в выданном порядке.');
  }

  return {
    ok: errors.length === 0,
    parsed: true,
    errors,
    player,
    evidence: {
      heroId: Number(player.hero_id),
      purchaseIndices,
      finalItemIds: finalIds,
      duration: Number(match.duration),
      gameMode: Number(match.game_mode),
      lobbyType: Number(match.lobby_type)
    }
  };
}
