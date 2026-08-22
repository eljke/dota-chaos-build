import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeStratzMatch, openDotaRateLimit } from '../worker/src/providers.js';
import { verifyMatch } from '../worker/src/verify.js';

const payload = {
  data: {
    match: {
      id: '9000000001', didRadiantWin: true, durationSeconds: 1800, startDateTime: 2000,
      lobbyType: 'RANKED', gameMode: 'TURBO', radiantKills: 20, direKills: 10,
      playbackData: { runeEvents: [{ indexId: 0 }, { indexId: 0 }] },
      players: [{
        steamAccountId: 42, playerSlot: 0, isVictory: true, heroId: 2,
        kills: 8, deaths: 2, assists: 8, leaverStatus: 0, towerDamage: 2500,
        item0Id: 50, item1Id: 1, item2Id: 108, item3Id: 609, item4Id: 0, item5Id: 0,
        backpack0Id: 0, backpack1Id: 0, backpack2Id: 0,
        stats: {
          itemPurchases: [
            { itemId: 50, time: 100 }, { itemId: 1, time: 200 },
            { itemId: 108, time: 300 }, { itemId: 609, time: 400 },
            { itemId: 188, time: 500 }
          ],
          itemUsed: [{ itemId: 188, count: 1 }],
          wards: [{ type: 0 }, { type: 1 }],
          campStack: [0, 1, 0, 1]
        },
        playbackData: { buyBackEvents: [] }
      }]
    }
  }
};

test('normalizes STRATZ match into verification shape', () => {
  const match = normalizeStratzMatch(payload);
  assert.equal(match.ranked_data_source, 'stratz');
  assert.equal(match.players[0].purchase_log[0].id, 50);
  assert.equal(match.players[0].item_uses_by_id[188], 1);
  assert.equal(match.players[0].camps_stacked, 2);
  assert.equal(match.players[0].rune_pickups, 2);
  assert.equal(match.lobby_type, 7);
  assert.equal(match.game_mode, 23);
});

test('STRATZ item-id purchase log can verify a ranked build', () => {
  const match = normalizeStratzMatch(payload);
  const attempt = {
    mode: 'turbo', hero_id: 2, committed_at: 1900, match_guard_seconds: 60,
    order_required: 1, modifier_id: null,
    items: [
      { id: 50, key: 'phase_boots', sourceKey: 'phase_boots', name: 'Phase Boots' },
      { id: 1, key: 'blink', sourceKey: 'blink', name: 'Blink Dagger' }
    ]
  };
  assert.equal(verifyMatch({ match, attempt, accountId: 42 }).ok, true);
});

test('daily OpenDota limit waits until the next UTC reset', () => {
  const now = Math.floor(Date.UTC(2026, 7, 7, 12, 0, 0) / 1000);
  const limit = openDotaRateLimit('{"error":"daily api limit exceeded"}', {}, now);
  assert.equal(limit.kind, 'daily');
  assert.equal(limit.retryAfter, 12 * 60 * 60 + 5);
  assert.equal(limit.blockedUntil, now + 12 * 60 * 60 + 5);
});

test('STRATZ normalized purchases keep id-based counters', () => {
  const match = normalizeStratzMatch(payload);
  assert.equal(match.players[0].purchase_by_id[188], 1);
});
