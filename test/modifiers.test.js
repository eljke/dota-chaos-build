import assert from 'node:assert/strict';
import test from 'node:test';
import { eligibleModifiers, MODIFIERS } from '../js/modifiers.js';
import { calculateScore, verifyModifier } from '../worker/src/verify.js';

const items = [
  { key: 'phase_boots', sourceKey: 'phase_boots', cost: 1500 },
  { key: 'blink', sourceKey: 'blink', cost: 2250 },
  { key: 'heart', sourceKey: 'heart', cost: 5200 }
];
const attempt = { mode: 'normal', items };
const player = {
  player_slot: 0, kills: 8, assists: 16, deaths: 4,
  buyback_count: 0, tower_damage: 3500, rune_pickups: 6, camps_stacked: 3,
  obs_placed: 4, sen_placed: 4,
  purchase: { smoke_of_deceit: 2 }, item_uses: { smoke_of_deceit: 2 },
  purchase_log: [
    { key: 'phase_boots' }, { key: 'ultimate_scepter' }, { key: 'blink' },
    { key: 'aghanims_shard' }, { key: 'heart' }
  ]
};
const match = { radiant_score: 40, dire_score: 25 };

test('all published modifiers have verifiable passing evidence', () => {
  for (const modifier of MODIFIERS) {
    const proof = verifyModifier({ modifierId: modifier.id, match, player, attempt });
    assert.equal(proof.ok, true, modifier.id);
    assert.equal(proof.evidence.id, modifier.id);
  }
});

test('role and build filters avoid unsuitable modifiers', () => {
  const carry = eligibleModifiers({ hero: { roles: ['Carry'] }, items: items.slice(0, 2) });
  assert.equal(carry.some(modifier => modifier.id === 'vision'), false);
  assert.equal(carry.some(modifier => modifier.id === 'shard-before-luxury'), false);

  const support = eligibleModifiers({ hero: { roles: ['Support'] }, items });
  assert.equal(support.some(modifier => modifier.id === 'vision'), true);
  assert.equal(support.some(modifier => modifier.id === 'shard-before-luxury'), true);
});

test('modifier difficulty affects score after reroll penalty', () => {
  assert.equal(calculateScore({ rerolls: 1, orderRequired: true, modifierMultiplier: 1.15 }), 690);
});

test('failed evidence explains the assigned modifier', () => {
  const failed = { ...player, tower_damage: 2999 };
  const proof = verifyModifier({ modifierId: 'tower-pressure', match, player: failed, attempt });
  assert.equal(proof.ok, false);
  assert.match(proof.error, /Осадный контракт/);
});
