import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateScore, canRetryVerificationJob, canSubmitAttempt, completionMultiplier, verifyMatch } from '../worker/src/verify.js';

const items = [
  { id: 50, key: 'phase_boots', sourceKey: 'phase_boots', name: 'Phase Boots' },
  { id: 1, key: 'blink', sourceKey: 'blink', name: 'Blink Dagger' }
];
const attempt = {
  mode: 'normal', hero_id: 2, committed_at: 1000, match_guard_seconds: 0, order_required: 1, items
};
const player = {
  account_id: 42, hero_id: 2, win: 1, leaver_status: 0,
  purchase_log: [
    { key: 'phase_boots', time: 500 }, { key: 'blink', time: 800 }
  ],
  item_0: 50, item_1: 1, item_2: 0, item_3: 0, item_4: 0, item_5: 0,
  backpack_0: 0, backpack_1: 0, backpack_2: 0
};
const match = { players: [player], lobby_type: 7, game_mode: 22, start_time: 1010, duration: 2400 };

test('score accounts for order and every seen build', () => {
  assert.equal(calculateScore({ rerolls: 0, orderRequired: true }), 1200);
  assert.equal(calculateScore({ rerolls: 0, orderRequired: true, startingBuyCompleted: true }), 1260);
  assert.equal(calculateScore({ rerolls: 1, orderRequired: true }), 600);
  assert.equal(calculateScore({ rerolls: 4, orderRequired: false }), 200);
  assert.equal(calculateScore({ rerolls: 0, cancelPenalties: 1, orderRequired: false }), 500);
});

test('deferred attempt accepts a match id later', () => {
  assert.equal(canSubmitAttempt({ status: 'committed', deferred_at: 0 }), true);
  assert.equal(canSubmitAttempt({ status: 'expired', deferred_at: 123 }), true);
  assert.equal(canSubmitAttempt({ status: 'expired', deferred_at: 0 }), false);
});

test('valid match proves hero, victory, inventory and order', () => {
  assert.equal(verifyMatch({ match, attempt, accountId: 42 }).ok, true);
});

test('wrong purchase order keeps the win without its bonus', () => {
  const reversed = structuredClone(match);
  reversed.players[0].purchase_log[0] = { key: 'blink', time: 500 };
  reversed.players[0].purchase_log[1] = { key: 'phase_boots', time: 800 };
  const result = verifyMatch({ match: reversed, attempt, accountId: 42 });
  assert.equal(result.ok, true);
  assert.equal(result.orderCompleted, false);
});

test('complete pregame buy earns its bonus', () => {
  const startingItems = [
    { id: 44, key: 'tango', sourceKey: 'tango', name: 'Tango' },
    { id: 16, key: 'branches', sourceKey: 'branches', name: 'Iron Branch' },
    { id: 16, key: 'branches', sourceKey: 'branches', name: 'Iron Branch' }
  ];
  const proAttempt = { ...attempt, starting_items: startingItems };
  const proMatch = structuredClone(match);
  proMatch.players[0].purchase_log.unshift(
    { id: 44, time: -20 }, { id: 16, time: -19 }, { id: 16, time: -18 }
  );

  const result = verifyMatch({ match: proMatch, attempt: proAttempt, accountId: 42 });
  assert.equal(result.startingBuyCompleted, true);
  assert.equal(calculateScore({ rerolls: 0, orderRequired: false, startingBuyCompleted: true }), 1050);
});

test('unparsed match verifies final inventory without order bonus', () => {
  const unparsed = structuredClone(match);
  delete unparsed.players[0].purchase_log;
  const result = verifyMatch({ match: unparsed, attempt, accountId: 42 });
  assert.equal(result.parsed, true);
  assert.equal(result.ok, true);
  assert.equal(result.completedItems, 2);
  assert.equal(result.orderCompleted, false);
  assert.equal(result.startingBuyCompleted, false);
  assert.equal(result.evidence.inventoryOnly, true);
});

test('unparsed wrong match is rejected without requesting replay data', () => {
  const unparsedWrong = structuredClone(match);
  delete unparsedWrong.players[0].purchase_log;
  unparsedWrong.players[0].hero_id = 99;
  const result = verifyMatch({ match: unparsedWrong, attempt, accountId: 42 });
  assert.equal(result.parsed, true);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.includes('не выданный герой')));
});

test('failed modifier keeps the win eligible without its bonus', () => {
  const challenged = { ...attempt, modifier_id: 'tower-pressure' };
  const result = verifyMatch({ match, attempt: challenged, accountId: 42 });
  assert.equal(result.ok, true);
  assert.equal(result.modifierCompleted, false);
  assert.equal(result.evidence.modifier.ok, false);
  assert.equal(calculateScore({ rerolls: 0, orderRequired: false, modifierMultiplier: 1 }), 1000);
});

test('build must be assigned no later than match start', () => {
  const late = { ...attempt, committed_at: 1300, match_guard_seconds: 0 };
  const result = verifyMatch({ match: { ...match, start_time: 1299 }, attempt: late, accountId: 42 });
  assert.equal(result.ok, false);
  assert.ok(result.errorCodes.includes('started_too_early'));
  assert.ok(result.errors.some(error => error.includes('после начала')));

  const onTime = { ...attempt, committed_at: 1299, match_guard_seconds: 0 };
  assert.equal(verifyMatch({ match: { ...match, start_time: 1299 }, attempt: onTime, accountId: 42 }).ok, true);

  const duringPregame = { ...attempt, committed_at: 1359, match_guard_seconds: 0 };
  assert.equal(verifyMatch({
    match: { ...match, start_time: 1299, pre_game_duration: 60 }, attempt: duringPregame, accountId: 42
  }).ok, true);
});

test('only recoverable verification errors can be retried', () => {
  assert.equal(canRetryVerificationJob({ status: 'error', message: 'Provider timeout.' }), true);
  assert.equal(canRetryVerificationJob({ status: 'rejected', message: 'Wrong hero.' }), false);
  assert.equal(canRetryVerificationJob({ status: 'stale', message: 'Build changed.' }), false);
  assert.equal(canRetryVerificationJob({ status: 'error', message: 'Этот матч или попытка уже подтверждены.' }), false);
});


test('partial build receives an exponential score reduction', () => {
  const partialItems = Array.from({ length: 6 }, (_, index) => ({
    id: 100 + index,
    key: `item_${index}`,
    sourceKey: `item_${index}`,
    name: `Item ${index + 1}`
  }));
  const partialAttempt = { ...attempt, order_required: 0, items: partialItems };
  const partialMatch = structuredClone(match);
  partialMatch.players[0].purchase_log = [
    { key: 'item_0' }, { key: 'item_1' }, { key: 'item_2' },
    { key: 'ultimate_scepter' }, { key: 'aghanims_shard' }
  ];
  Object.assign(partialMatch.players[0], {
    item_0: 100, item_1: 101, item_2: 102,
    item_3: 0, item_4: 0, item_5: 0,
    backpack_0: 0, backpack_1: 0, backpack_2: 0
  });

  const result = verifyMatch({ match: partialMatch, attempt: partialAttempt, accountId: 42 });
  assert.equal(result.ok, true);
  assert.equal(result.completedItems, 3);
  assert.equal(result.totalItems, 6);
  assert.ok(Math.abs(result.completionMultiplier - 0.216) < 1e-12);
  assert.equal(completionMultiplier(5, 6), 0.6);
  assert.equal(calculateScore({ rerolls: 0, orderRequired: false, completedItems: 3, totalItems: 6 }), 216);
});

test('legacy Aegis slots are ignored during verification', () => {
  const legacyAttempt = { ...attempt, items: [...items, { id: 117, key: 'aegis', name: 'Aegis' }] };
  const result = verifyMatch({ match, attempt: legacyAttempt, accountId: 42 });
  assert.equal(result.ok, true);
  assert.equal(result.totalItems, items.length);
});

test('an upgraded item counts for its original build component', () => {
  const upgradedAttempt = {
    ...attempt,
    order_required: 0,
    items: [{
      id: 534,
      key: 'witch_blade',
      sourceKey: 'witch_blade',
      name: 'Witch Blade',
      upgradeIds: [1806],
      upgradeKeys: ['devastator']
    }]
  };
  const upgradedMatch = structuredClone(match);
  upgradedMatch.players[0].purchase_log = [
    { key: 'devastator', id: 1806 },
    { key: 'ultimate_scepter', id: 108 },
    { key: 'aghanims_shard', id: 609 }
  ];
  Object.assign(upgradedMatch.players[0], {
    item_0: 1806, item_1: 0, item_2: 0, item_3: 0, item_4: 0, item_5: 0
  });

  const result = verifyMatch({ match: upgradedMatch, attempt: upgradedAttempt, accountId: 42 });
  assert.equal(result.ok, true);
  assert.equal(result.completedItems, 1);
  assert.equal(result.evidence.matchedItems[0].upgraded, true);
  assert.equal(result.evidence.matchedItems[0].finalItemId, 1806);
});

test('one final upgraded item cannot satisfy two build slots', () => {
  const sharedUpgradeAttempt = {
    ...attempt,
    order_required: 0,
    items: [
      { id: 534, key: 'witch_blade', sourceKey: 'witch_blade', name: 'Witch Blade', upgradeIds: [1806], upgradeKeys: ['devastator'] },
      { id: 57, key: 'mystic_staff', sourceKey: 'mystic_staff', name: 'Mystic Staff', upgradeIds: [1806], upgradeKeys: ['devastator'] }
    ]
  };
  const sharedUpgradeMatch = structuredClone(match);
  sharedUpgradeMatch.players[0].purchase_log = [
    { key: 'witch_blade', id: 534 }, { key: 'mystic_staff', id: 57 }, { key: 'devastator', id: 1806 },
    { key: 'ultimate_scepter', id: 108 }, { key: 'aghanims_shard', id: 609 }
  ];
  Object.assign(sharedUpgradeMatch.players[0], {
    item_0: 1806, item_1: 0, item_2: 0, item_3: 0, item_4: 0, item_5: 0
  });

  const result = verifyMatch({ match: sharedUpgradeMatch, attempt: sharedUpgradeAttempt, accountId: 42 });
  assert.equal(result.ok, true);
  assert.equal(result.completedItems, 1);
});
