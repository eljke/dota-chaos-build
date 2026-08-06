import assert from 'node:assert/strict';
import test from 'node:test';
import { generateBuild, seededRandom, shuffle } from '../js/generator.js';

const heroes = [
  { key: 'axe', attack_type: 'Melee' },
  { key: 'drow', attack_type: 'Ranged' }
];
const items = Object.fromEntries([
  ['phase_boots', 1500], ['power_treads', 1400], ['blink', 2250], ['heart', 5200],
  ['skadi', 5300], ['butterfly', 5450], ['sphere', 4800], ['rapier', 5600]
].map(([key, cost]) => [key, { key, cost }]));

test('seeded random is deterministic', () => {
  const first = seededRandom('same-seed');
  const second = seededRandom('same-seed');
  assert.deepEqual([first(), first(), first()], [second(), second(), second()]);
});

test('shuffle does not mutate input', () => {
  const source = [1, 2, 3, 4];
  shuffle(source, seededRandom('shuffle'));
  assert.deepEqual(source, [1, 2, 3, 4]);
});

test('build is deterministic and keeps a boot in slot zero', () => {
  const options = {
    seed: 'ABC123', forceBootSlot: true, heroes,
    itemPool: Object.values(items).filter(item => item.key !== 'rapier'), itemsByKey: items,
    bootKeys: ['phase_boots', 'power_treads'], isCompatible: () => true,
    modifierCount: 10, rapierChance: 0
  };
  const first = generateBuild(options);
  const second = generateBuild(options);
  assert.equal(first.hero.key, second.hero.key);
  assert.deepEqual(first.items.map(item => item.key), second.items.map(item => item.key));
  assert.ok(['phase_boots', 'power_treads'].includes(first.items[0].key));
  assert.equal(new Set(first.items.map(item => item.key)).size, 6);
});
