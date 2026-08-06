import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateScore, verifyMatch } from '../worker/src/verify.js';

const items = [
  { id: 50, key: 'phase_boots', sourceKey: 'phase_boots', name: 'Phase Boots' },
  { id: 1, key: 'blink', sourceKey: 'blink', name: 'Blink Dagger' }
];
const attempt = {
  mode: 'normal', hero_id: 2, committed_at: 1000, order_required: 1, items
};
const player = {
  account_id: 42, hero_id: 2, win: 1, leaver_status: 0,
  purchase_log: [
    { key: 'phase_boots', time: 500 }, { key: 'blink', time: 800 },
    { key: 'ultimate_scepter', time: 900 }, { key: 'aghanims_shard', time: 1000 }
  ],
  item_0: 50, item_1: 1, item_2: 0, item_3: 0, item_4: 0, item_5: 0,
  backpack_0: 0, backpack_1: 0, backpack_2: 0
};
const match = { players: [player], lobby_type: 7, game_mode: 22, start_time: 1010, duration: 2400 };

test('score accounts for order and every seen build', () => {
  assert.equal(calculateScore({ rerolls: 0, orderRequired: true }), 1200);
  assert.equal(calculateScore({ rerolls: 1, orderRequired: true }), 600);
  assert.equal(calculateScore({ rerolls: 4, orderRequired: false }), 200);
});

test('valid match proves hero, victory, inventory and order', () => {
  assert.equal(verifyMatch({ match, attempt, accountId: 42 }).ok, true);
});

test('wrong purchase order fails strict order proof', () => {
  const reversed = structuredClone(match);
  reversed.players[0].purchase_log[0] = { key: 'blink', time: 500 };
  reversed.players[0].purchase_log[1] = { key: 'phase_boots', time: 800 };
  const result = verifyMatch({ match: reversed, attempt, accountId: 42 });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.includes('порядке')));
});

test('unparsed match asks for replay parsing', () => {
  const unparsed = structuredClone(match);
  delete unparsed.players[0].purchase_log;
  assert.equal(verifyMatch({ match: unparsed, attempt, accountId: 42 }).parsed, false);
});
