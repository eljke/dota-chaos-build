'use strict';

import { generateBuild, pick, seededRandom } from './js/generator.js?v=2.0.1';
import { decodeBuildCode, encodeBuildCode } from './js/build-code.js?v=2.0.1';
import { MODIFIERS as CONTRACTS } from './js/modifiers.js?v=2.0.1';
import { applyTranslations, getLocale, initI18n, modifierText, t } from './js/i18n.js?v=2.0.1';
import { initRanked } from './js/ranked-client.js?v=2.0.1';
import { initStats } from './js/stats-client.js?v=2.0.1';
import {
  BOOT_KEYS, BOOT_KEY_SET, ITEM_KEY_ALIASES, ITEM_POOL_KEYS,
  MELEE_ONLY, RANGED_ONLY, isItemCompatible
} from './js/item-rules.js?v=2.0.1';

const CONFIG = {
  patchFallback: '7.41e',
  rapierChance: 0.0035,
  steamCdn: 'https://cdn.cloudflare.steamstatic.com',
  metaSources: ['./data/meta.json'],
  sources: [
    {
      name: 'local',
      heroes: './data/heroes.json',
      items: './data/items.json'
    },
    {
      name: 'jsDelivr',
      heroes: 'https://cdn.jsdelivr.net/gh/odota/dotaconstants@master/build/heroes.json',
      items: 'https://cdn.jsdelivr.net/gh/odota/dotaconstants@master/build/items.json'
    },
    {
      name: 'GitHub Raw',
      heroes: 'https://raw.githubusercontent.com/odota/dotaconstants/master/build/heroes.json',
      items: 'https://raw.githubusercontent.com/odota/dotaconstants/master/build/items.json'
    }
  ]
};

const EXCLUDED_GENERIC = new Set([
  'rapier', 'ultimate_scepter', 'ultimate_scepter_2', 'aghanims_shard', 'moon_shard',
  'gem', 'courier', 'flying_courier', 'tpscroll', 'dust', 'smoke_of_deceit',
  'ward_observer', 'ward_sentry', 'ward_dispenser', 'tango', 'clarity', 'flask', 'bottle',
  'cheese', 'aegis', 'refresher_shard', 'tome_of_knowledge', 'recipe', 'blood_grenade'
]);

const ROLE_RU = {
  Carry: 'Керри', Support: 'Поддержка', Nuker: 'Нюкер', Disabler: 'Контроль',
  Jungler: 'Лес', Durable: 'Танк', Escape: 'Мобильность', Pusher: 'Пуш', Initiator: 'Инициация'
};
const ATTR_GLYPH = { str: 'S', agi: 'A', int: 'I', all: 'U' };

const FALLBACK_HEROES = [
  ['antimage', 'Anti-Mage', 'agi', 'Melee', ['Carry', 'Escape', 'Nuker'], 150, 310],
  ['axe', 'Axe', 'str', 'Melee', ['Initiator', 'Durable', 'Disabler'], 150, 315],
  ['crystal_maiden', 'Crystal Maiden', 'int', 'Ranged', ['Support', 'Disabler', 'Nuker'], 600, 280],
  ['drow_ranger', 'Drow Ranger', 'agi', 'Ranged', ['Carry', 'Disabler', 'Pusher'], 625, 310],
  ['earthshaker', 'Earthshaker', 'str', 'Melee', ['Support', 'Initiator', 'Disabler'], 150, 315],
  ['juggernaut', 'Juggernaut', 'agi', 'Melee', ['Carry', 'Pusher', 'Escape'], 150, 300],
  ['mirana', 'Mirana', 'agi', 'Ranged', ['Carry', 'Support', 'Escape'], 630, 285],
  ['pudge', 'Pudge', 'str', 'Melee', ['Disabler', 'Initiator', 'Durable'], 175, 280],
  ['shadow_fiend', 'Shadow Fiend', 'agi', 'Ranged', ['Carry', 'Nuker'], 525, 305, 'nevermore'],
  ['invoker', 'Invoker', 'all', 'Ranged', ['Carry', 'Nuker', 'Disabler'], 600, 280],
  ['phantom_assassin', 'Phantom Assassin', 'agi', 'Melee', ['Carry', 'Escape'], 150, 305],
  ['sniper', 'Sniper', 'agi', 'Ranged', ['Carry', 'Nuker'], 550, 285],
  ['lina', 'Lina', 'int', 'Ranged', ['Support', 'Carry', 'Nuker'], 670, 290],
  ['mars', 'Mars', 'str', 'Melee', ['Carry', 'Initiator', 'Durable'], 250, 310],
  ['hoodwink', 'Hoodwink', 'agi', 'Ranged', ['Support', 'Nuker', 'Escape'], 575, 310],
  ['dawnbreaker', 'Dawnbreaker', 'str', 'Melee', ['Carry', 'Durable'], 150, 300],
  ['marci', 'Marci', 'all', 'Melee', ['Support', 'Carry', 'Initiator'], 150, 315],
  ['primal_beast', 'Primal Beast', 'str', 'Melee', ['Initiator', 'Durable', 'Disabler'], 150, 310],
  ['muerta', 'Muerta', 'int', 'Ranged', ['Carry', 'Nuker', 'Disabler'], 575, 295],
  ['ringmaster', 'Ringmaster', 'int', 'Ranged', ['Support', 'Disabler', 'Nuker'], 500, 310],
  ['kez', 'Kez', 'agi', 'Melee', ['Carry', 'Escape', 'Disabler'], 150, 315],
  ['largo', 'Largo', 'str', 'Melee', ['Durable', 'Initiator'], 150, 300]
].map((row, index) => ({
  id: index + 1,
  key: row[0],
  localized_name: row[1],
  primary_attr: row[2],
  attack_type: row[3],
  roles: row[4],
  attack_range: row[5],
  move_speed: row[6],
  name: `npc_dota_hero_${row[7] || row[0]}`,
  img: `/apps/dota2/images/dota_react/heroes/${row[7] || row[0]}.png?`
}));

const FALLBACK_ITEM_ROWS = [
  ['phase_boots','Phase Boots',1500,'rare'],['power_treads','Power Treads',1400,'rare'],['arcane_boots','Arcane Boots',1500,'rare'],
  ['guardian_greaves','Guardian Greaves',4450,'artifact'],['boots_of_bearing','Boots of Bearing',4650,'artifact'],
  ['blink','Blink Dagger',2250,'rare'],['overwhelming_blink','Overwhelming Blink',6800,'artifact'],['swift_blink','Swift Blink',6800,'artifact'],['arcane_blink','Arcane Blink',6800,'artifact'],
  ['black_king_bar','Black King Bar',4050,'epic'],['sphere',"Linken's Sphere",4800,'epic'],['lotus_orb','Lotus Orb',3850,'epic'],
  ['aeon_disk','Aeon Disk',3000,'rare'],['blade_mail','Blade Mail',2300,'rare'],['heart','Heart of Tarrasque',5200,'artifact'],
  ['shivas_guard',"Shiva's Guard",4850,'artifact'],['assault','Assault Cuirass',5125,'artifact'],['bloodstone','Bloodstone',4400,'artifact'],
  ['pipe','Pipe of Insight',3725,'epic'],['crimson_guard','Crimson Guard',3725,'epic'],['consecrated_wraps','Consecrated Wraps',2600,'epic'],
  ['satanic','Satanic',5050,'artifact'],['skadi','Eye of Skadi',5300,'artifact'],['butterfly','Butterfly',5450,'epic'],
  ['monkey_king_bar','Monkey King Bar',5000,'epic'],['greater_crit','Daedalus',5100,'epic'],['desolator','Desolator',3500,'epic'],
  ['silver_edge','Silver Edge',5450,'epic'],['radiance','Radiance',4700,'artifact'],['mjollnir','Mjollnir',5500,'artifact'],
  ['moon_shard','Moon Shard',4000,'artifact'],['nullifier','Nullifier',4375,'artifact'],['disperser','Disperser',6100,'artifact'],
  ['manta','Manta Style',4650,'epic'],['sange_and_yasha','Sange and Yasha',4100,'epic'],['yasha_and_kaya','Yasha and Kaya',4100,'epic'],
  ['kaya_and_sange','Kaya and Sange',4100,'epic'],['heavens_halberd',"Heaven's Halberd",3500,'epic'],['armlet','Armlet of Mordiggian',2500,'rare'],
  ['mask_of_madness','Mask of Madness',1900,'rare'],['mage_slayer','Mage Slayer',2825,'epic'],['orchid','Orchid Malevolence',3275,'epic'],
  ['bloodthorn','Bloodthorn',6625,'artifact'],['witch_blade','Witch Blade',2775,'epic'],['parasma','Parasma',5975,'artifact'],
  ['angels_demise','Khanda',5600,'common'],['phylactery','Phylactery',2600,'rare'],['ethereal_blade','Ethereal Blade',5375,'artifact'],
  ['dagon_5','Dagon 5',7400,'artifact'],['octarine_core','Octarine Core',4800,'artifact'],['refresher','Refresher Orb',5000,'artifact'],
  ['sheepstick','Scythe of Vyse',5200,'artifact'],['wind_waker','Wind Waker',6825,'artifact'],['gleipnir','Gleipnir',4650,'artifact'],
  ['revenants_brooch',"Revenant's Brooch",4900,'artifact'],['force_staff','Force Staff',2200,'rare'],['glimmer_cape','Glimmer Cape',2150,'rare'],
  ['solar_crest','Solar Crest',2700,'rare'],['holy_locket','Holy Locket',2250,'rare'],['spirit_vessel','Spirit Vessel',2780,'rare'],
  ['essence_distiller','Essence Distiller',1775,'rare'],['crellas_crozier',"Crella's Crozier",4800,'epic'],['hand_of_midas','Hand of Midas',2200,'rare'],
  ['helm_of_the_overlord','Helm of the Overlord',5700,'artifact'],['battlefury','Battle Fury',4100,'epic'],['basher','Skull Basher',2875,'epic'],
  ['abyssal_blade','Abyssal Blade',6250,'artifact'],['echo_sabre','Echo Sabre',2700,'epic'],['harpoon','Harpoon',4700,'artifact'],
  ['dragon_lance','Dragon Lance',1900,'rare'],['hurricane_pike','Hurricane Pike',4450,'epic'],['specialists_array',"Specialist's Array",2550,'rare'],
  ['hydras_breath',"Hydra's Breath",5900,'rare'],['rapier','Divine Rapier',5600,'epic']
];

const FALLBACK_ITEMS = Object.fromEntries(FALLBACK_ITEM_ROWS.map(([key, dname, cost, qual]) => [key, {
  id: key,
  dname,
  cost,
  qual,
  img: `/apps/dota2/images/dota_react/items/${key}.png?t=1`,
  created: true,
  lore: ''
}]));

FALLBACK_ITEMS.ultimate_scepter = {
  dname: "Aghanim's Scepter", cost: 4200, qual: 'rare',
  img: '/apps/dota2/images/dota_react/items/ultimate_scepter.png?t=1'
};
FALLBACK_ITEMS.aghanims_shard = {
  dname: "Aghanim's Shard", cost: 1400, qual: 'rare',
  img: '/apps/dota2/images/dota_react/items/aghanims_shard.png?t=1'
};

const dom = {
  patchLabel: document.querySelector('#patchLabel'),
  dataState: document.querySelector('#dataState'),
  heroPanel: document.querySelector('.hero-panel'),
  heroPortrait: document.querySelector('#heroPortrait'),
  heroBackdrop: document.querySelector('#heroBackdrop'),
  heroAttribute: document.querySelector('#heroAttribute'),
  heroAttackType: document.querySelector('#heroAttackType'),
  heroName: document.querySelector('#heroName'),
  heroRoles: document.querySelector('#heroRoles'),
  heroRange: document.querySelector('#heroRange'),
  heroSpeed: document.querySelector('#heroSpeed'),
  heroAttrText: document.querySelector('#heroAttrText'),
  rerollHeroButton: document.querySelector('#rerollHeroButton'),
  inventoryGrid: document.querySelector('#inventoryGrid'),
  slotTemplate: document.querySelector('#inventorySlotTemplate'),
  itemInspector: document.querySelector('#itemInspector'),
  buildCost: document.querySelector('#buildCost'),
  generateButton: document.querySelector('#generateButton'),
  rerollUnlockedButton: document.querySelector('#rerollUnlockedButton'),
  forceBootSlotToggle: document.querySelector('#forceBootSlotToggle'),
  scepterSlotButton: document.querySelector('#scepterSlotButton'),
  shardSlotButton: document.querySelector('#shardSlotButton'),
  scepterImage: document.querySelector('#scepterImage'),
  shardImage: document.querySelector('#shardImage'),
  contractName: document.querySelector('#contractName'),
  contractDescription: document.querySelector('#contractDescription'),
  rerollContractButton: document.querySelector('#rerollContractButton'),
  showContractsButton: document.querySelector('#showContractsButton'),
  contractsDialog: document.querySelector('#contractsDialog'),
  contractsList: document.querySelector('#contractsList'),
  closeContractsButton: document.querySelector('#closeContractsButton'),
  releaseNotesButton: document.querySelector('#releaseNotesButton'),
  releaseNotesDialog: document.querySelector('#releaseNotesDialog'),
  closeReleaseNotesButton: document.querySelector('#closeReleaseNotesButton'),
  lobbyCodeOutput: document.querySelector('#lobbyCodeOutput'),
  copyLobbyCodeButton: document.querySelector('#copyLobbyCodeButton'),
  lobbyCodeInput: document.querySelector('#lobbyCodeInput'),
  importLobbyCodeButton: document.querySelector('#importLobbyCodeButton'),
  shareButton: document.querySelector('#shareButton'),
  statsLink: document.querySelector('#statsLink'),
  siteVersion: document.querySelector('#siteVersion'),
  toast: document.querySelector('#toast')
};

const state = {
  heroes: [],
  heroByKey: new Map(),
  itemsByKey: {},
  itemPool: [],
  hero: null,
  items: [],
  locked: new Set(),
  contractIndex: 0,
  selectedIndex: null,
  inspectorRootKey: null,
  inspectorPath: [],
  forceBootSlot: true,
  seed: '',
  meta: null,
  dataSourceName: '',
  usingFallback: false,
  ready: false
};

let toastTimer = null;

dom.patchLabel.textContent = CONFIG.patchFallback;

function assetUrl(path) {
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return path;
  const clean = path.split('?')[0];
  return `${CONFIG.steamCdn}${clean}`;
}

function heroKey(hero) {
  return hero.key || String(hero.name || '').replace('npc_dota_hero_', '');
}

function normalizeHeroes(raw) {
  return Object.values(raw || {})
    .filter(hero => hero && hero.localized_name && hero.name && Number(hero.id) > 0)
    .map(hero => ({ ...hero, key: heroKey(hero) }))
    .filter(hero => !['base', 'target_dummy'].includes(hero.key))
    .sort((a, b) => a.localized_name.localeCompare(b.localized_name));
}

function prettifyItemKey(key) {
  return String(key || '')
    .replace(/^recipe_/, '')
    .split('_')
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function normalizeItems(raw) {
  const output = {};

  for (const [key, item] of Object.entries(raw || {})) {
    if (!item || !item.img) continue;
    const isRecipe = key.startsWith('recipe_');
    const dname = item.dname || (isRecipe ? `${prettifyItemKey(key)} Recipe` : '');
    if (!dname) continue;
    output[key] = { ...item, dname, key, sourceKey: key };
  }

  for (const [publicKey, sourceKey] of Object.entries(ITEM_KEY_ALIASES)) {
    const source = output[sourceKey];
    if (source) output[publicKey] = { ...source, key: publicKey, sourceKey };

    const sourceRecipeKey = `recipe_${sourceKey}`;
    const publicRecipeKey = `recipe_${publicKey}`;
    const sourceRecipe = output[sourceRecipeKey];
    if (sourceRecipe) {
      output[publicRecipeKey] = {
        ...sourceRecipe,
        key: publicRecipeKey,
        sourceKey: sourceRecipeKey,
        dname: `${source?.dname || prettifyItemKey(publicKey)} Recipe`
      };
    }
  }

  return output;
}

function buildItemPool(itemsByKey) {
  const curated = ITEM_POOL_KEYS
    .map(key => itemsByKey[key])
    .filter(Boolean)
    .filter(item => item.key !== 'rapier');

  if (curated.length >= 40) return curated;

  return Object.values(itemsByKey).filter(item => {
    const key = item.key;
    const cost = Number(item.cost) || 0;
    if (!key || key.startsWith('recipe_') || EXCLUDED_GENERIC.has(key)) return false;
    if (cost < 1700 || item.created !== true) return false;
    if (!item.img || !item.dname || item.dname.includes('Recipe')) return false;
    if (key.includes('neutral') || key.includes('tier') || key.includes('enchanted')) return false;
    return true;
  });
}

async function fetchJson(url, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function loadRemoteData() {
  let lastError = null;
  for (const source of CONFIG.sources) {
    try {
      const [heroes, items] = await Promise.all([
        fetchJson(source.heroes),
        fetchJson(source.items)
      ]);
      return { heroes, items, sourceName: source.name };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(t('data.error'));
}

async function loadMeta() {
  for (const url of CONFIG.metaSources) {
    try {
      const meta = await fetchJson(url, 5000);

      if (dom.siteVersion) {
        const version = String(meta.siteVersion || '').trim();
        const revision = String(meta.siteRevision || '').trim();

        dom.siteVersion.textContent = version
            ? `v${version}`
            : revision
                ? `build ${revision}`
                : 'dev';

        dom.siteVersion.title = t('version.title', { version: version || revision || 'dev' });
      }

      return meta;
    } catch (error) {
      console.info('Patch metadata is unavailable:', error);
    }
  }

  if (dom.siteVersion) {
    dom.siteVersion.textContent = 'dev';
    dom.siteVersion.title = t('version.unavailable');
  }

  return null;
}

function applyMeta(meta) {
  state.meta = meta;
  const patch = String(meta?.patch || CONFIG.patchFallback);
  dom.patchLabel.textContent = patch;
  dom.patchLabel.parentElement.title = t('top.patch');
}

function setDataState(mode, text) {
  dom.dataState.className = `data-state ${mode ? `is-${mode}` : ''}`.trim();
  dom.dataState.innerHTML = `<i></i>${text}`;
}

function randomSeed() {
  const bytes = new Uint32Array(2);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    bytes[0] = Date.now();
    bytes[1] = Math.floor(Math.random() * 0xffffffff);
  }
  return ((BigInt(bytes[0]) << 32n) | BigInt(bytes[1])).toString(36).slice(0, 8).toUpperCase().padEnd(8, '0');
}

function isCompatible(item, hero) {
  return isItemCompatible(item, hero);
}

function compatiblePool(hero, excludedKeys = new Set(), options = {}) {
  const excludeBoots = options.excludeBoots === true;
  return state.itemPool.filter(item => (
    isCompatible(item, hero)
    && !excludedKeys.has(item.key)
    && (!excludeBoots || !BOOT_KEY_SET.has(item.key))
  ));
}

function bootPool(hero, excludedKeys = new Set()) {
  return BOOT_KEYS
    .map(key => state.itemsByKey[key])
    .filter(item => item && isCompatible(item, hero) && !excludedKeys.has(item.key));
}

function clearInspector() {
  state.selectedIndex = null;
  state.inspectorRootKey = null;
  state.inspectorPath = [];
}

function inspectItem(key, selectedIndex = null) {
  if (!state.itemsByKey[key]) return;
  state.selectedIndex = selectedIndex;
  state.inspectorRootKey = key;
  state.inspectorPath = [key];
  renderInventory();
  renderUpgrades();
  renderInspector();
}

function makeBuild(seed) {
  const build = generateBuild({
    seed,
    forceBootSlot: state.forceBootSlot,
    heroes: state.heroes,
    itemPool: state.itemPool,
    itemsByKey: state.itemsByKey,
    bootKeys: BOOT_KEYS,
    isCompatible,
    modifierCount: CONTRACTS.length,
    rapierChance: CONFIG.rapierChance
  });
  return { ...build, contractIndex: build.modifierIndex };
}

function generateFull(seed = randomSeed(), options = {}) {
  if (!state.ready) return;
  const build = makeBuild(seed);
  state.seed = seed;
  state.hero = build.hero;
  state.items = build.items;
  state.contractIndex = build.contractIndex;
  state.locked.clear();
  clearInspector();

  if (options.animate !== false) animateRoll();
  renderAll();
  updateUrl();
}

function animateRoll() {
  dom.heroPanel.classList.add('is-rolling');
  [...dom.inventoryGrid.children].forEach(slot => slot.classList.add('is-rolling'));
  setTimeout(() => {
    dom.heroPanel.classList.remove('is-rolling');
    [...dom.inventoryGrid.children].forEach(slot => slot.classList.remove('is-rolling'));
  }, 420);
}

function rerollHero() {
  if (!state.ready) return;
  const rng = seededRandom(`hero:${randomSeed()}:${state.seed}`);
  const candidates = state.heroes.filter(hero => hero.key !== state.hero.key);
  state.hero = pick(candidates, rng);

  const used = new Set();
  let replacedLocked = 0;
  state.items = state.items.map((item, index) => {
    const needsBoot = state.forceBootSlot && index === 0;
    const forbidsBoot = state.forceBootSlot && index > 0;
    const valid = isCompatible(item, state.hero)
      && !used.has(item.key)
      && (!needsBoot || BOOT_KEY_SET.has(item.key))
      && (!forbidsBoot || !BOOT_KEY_SET.has(item.key));

    if (valid) {
      used.add(item.key);
      return item;
    }

    const pool = needsBoot
      ? bootPool(state.hero, used)
      : compatiblePool(state.hero, used, { excludeBoots: forbidsBoot });
    const replacement = pick(pool, rng);
    if (!replacement) return item;
    used.add(replacement.key);
    if (state.locked.has(index)) replacedLocked += 1;
    return replacement;
  });

  if (state.selectedIndex !== null) {
    const selected = state.items[state.selectedIndex];
    state.inspectorRootKey = selected?.key || null;
    state.inspectorPath = selected ? [selected.key] : [];
  }
  state.seed = randomSeed();
  renderAll();
  updateUrl();
  if (replacedLocked) showToast(t('toast.lockedConflict'));
}

function rerollUnlocked() {
  if (!state.ready) return;
  const unlocked = [0, 1, 2, 3, 4, 5].filter(index => !state.locked.has(index));
  if (!unlocked.length) {
    showToast(t('toast.allLocked'));
    return;
  }

  const rng = seededRandom(`reroll:${randomSeed()}:${state.seed}:${state.forceBootSlot ? 'boot' : 'free'}`);
  const used = new Set(state.items.filter((_, index) => state.locked.has(index)).map(item => item.key));

  for (const index of unlocked) {
    const needsBoot = state.forceBootSlot && index === 0;
    const pool = needsBoot
      ? bootPool(state.hero, used)
      : compatiblePool(state.hero, used, { excludeBoots: state.forceBootSlot && index > 0 });
    if (!pool.length) break;
    const item = pick(pool, rng);
    state.items[index] = item;
    used.add(item.key);
  }

  state.seed = randomSeed();
  if (state.selectedIndex !== null && unlocked.includes(state.selectedIndex)) clearInspector();
  renderInventory();
  renderInspector();
  renderCost();
  renderSeed();
  updateUrl();
}

function toggleLock(index) {
  if (state.locked.has(index)) state.locked.delete(index);
  else state.locked.add(index);
  renderInventory();
  renderInspector();
  updateUrl();
}

function setForceBootSlot(enabled) {
  state.forceBootSlot = enabled;
  if (!state.ready || !state.hero || !enabled) {
    renderOptions();
    updateUrl();
    return;
  }

  const rng = seededRandom(`boot-toggle:${randomSeed()}:${state.seed}`);
  const changed = new Set();
  const used = new Set(state.items.slice(1).filter(item => !BOOT_KEY_SET.has(item.key)).map(item => item.key));
  const boot = pick(bootPool(state.hero, used), rng);
  if (boot && state.items[0]?.key !== boot.key) {
    state.items[0] = boot;
    changed.add(0);
  }

  for (let index = 1; index < state.items.length; index += 1) {
    if (!BOOT_KEY_SET.has(state.items[index]?.key)) continue;
    const excluded = new Set(state.items.filter((_, itemIndex) => itemIndex !== index).map(item => item.key));
    const replacement = pick(compatiblePool(state.hero, excluded, { excludeBoots: true }), rng);
    if (replacement) {
      state.items[index] = replacement;
      changed.add(index);
    }
  }

  if (state.selectedIndex !== null && changed.has(state.selectedIndex)) clearInspector();
  state.seed = randomSeed();
  renderAll();
  updateUrl();
  showToast(t('toast.bootLocked'));
}

function imageWithFallback(img, fallbackText = '?') {
  img.addEventListener('error', () => {
    img.style.display = 'none';
    img.parentElement?.setAttribute('data-fallback', fallbackText.slice(0, 2).toUpperCase());
  }, { once: true });
}

function renderHero() {
  const hero = state.hero;
  if (!hero) return;
  const image = assetUrl(hero.img);
  dom.heroPortrait.style.display = '';
  dom.heroPortrait.src = image;
  dom.heroPortrait.alt = hero.localized_name;
  dom.heroBackdrop.style.backgroundImage = `url("${image}")`;
  dom.heroName.textContent = hero.localized_name;
  dom.heroAttackType.textContent = t(hero.attack_type === 'Ranged' ? 'hero.ranged' : 'hero.melee');
  dom.heroAttackType.style.color = hero.attack_type === 'Ranged' ? '#6ea9c7' : '#b65e4c';
  dom.heroAttribute.dataset.attr = hero.primary_attr || 'all';
  dom.heroAttribute.textContent = ATTR_GLYPH[hero.primary_attr] || 'U';
  dom.heroAttribute.title = t(`attr.${hero.primary_attr || 'all'}`);
  dom.heroRoles.innerHTML = (hero.roles || []).slice(0, 5)
    .map(role => `<span class="role-chip">${getLocale() === 'ru' ? (ROLE_RU[role] || role) : role}</span>`)
    .join('');
  dom.heroRange.textContent = String(hero.attack_range ?? '—');
  dom.heroSpeed.textContent = String(hero.move_speed ?? '—');
  dom.heroAttrText.textContent = t(`attr.${hero.primary_attr || 'all'}`);
}

function renderInventory() {
  dom.inventoryGrid.innerHTML = '';

  state.items.forEach((item, index) => {
    const node = dom.slotTemplate.content.firstElementChild.cloneNode(true);
    const img = node.querySelector('img');
    const cost = node.querySelector('.item-cost');
    const lock = node.querySelector('.lock-button');
    const restriction = node.querySelector('.restriction-badge');
    img.src = assetUrl(item.img);
    img.alt = item.dname;
    imageWithFallback(img, item.dname);
    cost.textContent = Number(item.cost || 0).toLocaleString(getLocale());
    node.dataset.index = String(index);
    node.setAttribute('aria-label', `${item.dname}, ${t('item.gold', { cost: item.cost || 0 })}`);
    lock.setAttribute('aria-label', t(state.locked.has(index) ? 'item.unlock' : 'item.lock'));
    lock.title = t('item.lockHint');

    if (state.locked.has(index)) node.classList.add('is-locked');
    if (state.selectedIndex === index) node.classList.add('is-selected');
    if (item.key === 'rapier') node.classList.add('is-rapier');

    if (RANGED_ONLY.has(item.key)) {
      restriction.textContent = 'RNG';
      restriction.classList.add('is-ranged');
      restriction.title = t('item.ranged');
    } else if (MELEE_ONLY.has(item.key)) {
      restriction.textContent = 'MEL';
      restriction.classList.add('is-melee');
      restriction.title = t('item.melee');
    }

    node.addEventListener('click', () => inspectItem(item.key, index));
    node.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        inspectItem(item.key, index);
      }
    });
    lock.addEventListener('click', event => {
      event.stopPropagation();
      toggleLock(index);
    });

    dom.inventoryGrid.append(node);
  });
}

function plainText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function itemDescription(item) {
  if (item?.key?.startsWith('recipe_')) return t('item.recipe');
  const ability = Array.isArray(item.abilities) ? item.abilities[0] : null;
  return plainText(ability?.description || item.lore || item.notes || t('item.noDescription'));
}

function recipeComponents(item) {
  const sourceKey = item?.sourceKey || item?.key || '';
  const selfKeys = new Set([item?.key, sourceKey].filter(Boolean));
  const keys = Array.isArray(item?.components)
    ? item.components
      .map(key => String(key || '').trim())
      .filter(key => key && !selfKeys.has(key))
    : [];

  const publicRecipeKey = item?.key ? `recipe_${item.key}` : '';
  const sourceRecipeKey = sourceKey ? `recipe_${sourceKey}` : '';
  const recipe = state.itemsByKey[publicRecipeKey] || state.itemsByKey[sourceRecipeKey];
  if (recipe && Number(recipe.cost) > 0 && !keys.includes(recipe.key)) keys.push(recipe.key);

  const seen = new Set();
  return keys
    .map(key => state.itemsByKey[key])
    .filter(component => component && !selfKeys.has(component.key) && !seen.has(component.key) && seen.add(component.key));
}

function inspectorItem() {
  const key = state.inspectorPath.at(-1) || state.inspectorRootKey;
  return key ? state.itemsByKey[key] : null;
}

function renderInspector() {
  const item = inspectorItem();
  if (!item) {
    dom.itemInspector.innerHTML = `
      <div class="item-inspector__empty">
        <span class="mouse-icon" aria-hidden="true"></span>
        ${t('random.inspectorEmpty')}
      </div>`;
    return;
  }

  const isRecipe = item.key.startsWith('recipe_');
  const quality = isRecipe ? 'component' : (item.qual || 'common');
  const qualityLabel = t(isRecipe ? 'quality.recipe' : `quality.${quality}`) || t('quality.item');
  const tags = [];
  if (RANGED_ONLY.has(item.key)) tags.push(t('item.tagRanged'));
  if (MELEE_ONLY.has(item.key)) tags.push(t('item.tagMelee'));
  if (BOOT_KEY_SET.has(item.key)) tags.push(t('item.tagBoots'));
  if (Array.isArray(item.abilities)) tags.push(...item.abilities.slice(0, 2).map(ability => ability.title).filter(Boolean));
  if (state.selectedIndex !== null && state.locked.has(state.selectedIndex) && state.inspectorRootKey === item.key) {
    tags.push(t('item.tagLocked'));
  }

  const components = recipeComponents(item);
  const componentTotal = components.reduce((sum, component) => sum + (Number(component.cost) || 0), 0);
  const path = state.inspectorPath.length ? state.inspectorPath : [item.key];
  const breadcrumbs = path.map((key, index) => {
    const crumb = state.itemsByKey[key];
    if (!crumb) return '';
    const current = index === path.length - 1;
    return `<button type="button" data-crumb-index="${index}" ${current ? 'aria-current="page"' : ''}>${escapeHtml(crumb.dname)}</button>`;
  }).filter(Boolean).join('<span aria-hidden="true">›</span>');

  const recipeMarkup = components.length
    ? `
      <section class="recipe-panel" aria-label="${t('item.components')}">
        <div class="recipe-panel__head">
          <div><span>${t('item.recipeTree')}</span><strong>${t('item.madeFrom')}</strong></div>
          <small>${t('item.gold', { cost: componentTotal.toLocaleString(getLocale()) })}</small>
        </div>
        <div class="recipe-components">
          ${components.map(component => `
            <button class="recipe-component" type="button" data-component-key="${escapeHtml(component.key)}" title="${t('item.open', { item: escapeHtml(component.dname) })}">
              <span class="recipe-component__image"><img src="${assetUrl(component.img)}" alt=""></span>
              <span class="recipe-component__copy"><strong>${escapeHtml(component.dname)}</strong><small>${Number(component.cost || 0).toLocaleString(getLocale())}</small></span>
              <span class="recipe-component__arrow" aria-hidden="true">›</span>
            </button>`).join('')}
        </div>
      </section>`
    : `
      <div class="recipe-leaf">
        <span>${t('item.baseComponent')}</span>
        ${t('item.baseHint')}
      </div>`;

  dom.itemInspector.innerHTML = `
    <nav class="recipe-breadcrumbs" aria-label="${t('item.recipePath')}">
      ${path.length > 1 ? `<button class="recipe-back" type="button" data-recipe-back aria-label="${t('item.back')}">←</button>` : ''}
      <div>${breadcrumbs}</div>
    </nav>
    <article class="inspector-card">
      <span class="inspector-image"><img src="${assetUrl(item.img)}" alt="${escapeHtml(item.dname)}"></span>
      <div class="inspector-copy">
        <div class="inspector-topline">
          <h3>${escapeHtml(item.dname)}</h3>
          <span class="quality-chip quality-${escapeHtml(quality)}">${qualityLabel}</span>
        </div>
        <p class="inspector-description">${escapeHtml(itemDescription(item))}</p>
        <div class="inspector-tags">${tags.map(tag => `<span>${escapeHtml(tag)}</span>`).join('')}</div>
      </div>
      <div class="inspector-price">${Number(item.cost || 0).toLocaleString(getLocale())}</div>
    </article>
    ${recipeMarkup}`;

  dom.itemInspector.querySelectorAll('img').forEach(img => imageWithFallback(img, item.dname));
  dom.itemInspector.querySelector('[data-recipe-back]')?.addEventListener('click', () => {
    if (state.inspectorPath.length > 1) state.inspectorPath.pop();
    renderInspector();
  });
  dom.itemInspector.querySelectorAll('[data-crumb-index]').forEach(button => {
    button.addEventListener('click', () => {
      const index = Number(button.dataset.crumbIndex);
      state.inspectorPath = state.inspectorPath.slice(0, index + 1);
      renderInspector();
    });
  });
  dom.itemInspector.querySelectorAll('[data-component-key]').forEach(button => {
    button.addEventListener('click', () => {
      const key = button.dataset.componentKey;
      if (!state.itemsByKey[key] || state.inspectorPath.length >= 12) return;
      state.inspectorPath.push(key);
      renderInspector();
    });
  });
}

function renderCost() {
  const total = state.items.reduce((sum, item) => sum + (Number(item.cost) || 0), 0)
    + (Number(state.itemsByKey.ultimate_scepter?.cost) || 4200)
    + (Number(state.itemsByKey.aghanims_shard?.cost) || 1400);
  dom.buildCost.textContent = t('item.buildTotal', { cost: total.toLocaleString(getLocale()) });
}

function renderOptions() {
  dom.forceBootSlotToggle.checked = state.forceBootSlot;
}

function renderUpgrades() {
  const scepter = state.itemsByKey.ultimate_scepter || FALLBACK_ITEMS.ultimate_scepter;
  const shard = state.itemsByKey.aghanims_shard || FALLBACK_ITEMS.aghanims_shard;
  dom.scepterImage.src = assetUrl(scepter.img);
  dom.shardImage.src = assetUrl(shard.img);
  dom.scepterSlotButton.classList.toggle('is-selected', state.inspectorRootKey === 'ultimate_scepter');
  dom.shardSlotButton.classList.toggle('is-selected', state.inspectorRootKey === 'aghanims_shard');
}

function renderContract() {
  const contract = CONTRACTS[state.contractIndex] || CONTRACTS[0];
  const text = modifierText(contract);
  dom.contractName.textContent = text.name;
  dom.contractDescription.textContent = text.description;
}

function renderContractsCatalog() {
  dom.showContractsButton.textContent = `${t('random.allModifiers')} (${CONTRACTS.length})`;
  dom.contractsList.innerHTML = CONTRACTS.map((contract, index) => `
    <article class="contract-catalog-item ${index === state.contractIndex ? 'is-current' : ''}">
      <span>${String(index + 1).padStart(2, '0')}</span>
      <div><strong>${escapeHtml(modifierText(contract).name)}</strong><p>${escapeHtml(modifierText(contract).description)} · Ranked +${Math.round((contract.multiplier - 1) * 100)}%</p></div>
    </article>`).join('');
}

function currentLobbyCode() {
  return state.hero && state.items.length === 6 ? encodeBuildCode(serializeBuild()) : '';
}

function renderSeed() {
  dom.lobbyCodeOutput.value = currentLobbyCode();
}

function renderAll() {
  renderHero();
  renderInventory();
  renderInspector();
  renderCost();
  renderOptions();
  renderUpgrades();
  renderContract();
  renderContractsCatalog();
  renderSeed();
}


function rerollContract() {
  let next = state.contractIndex;
  while (next === state.contractIndex && CONTRACTS.length > 1) {
    next = Math.floor(Math.random() * CONTRACTS.length);
  }
  state.contractIndex = next;
  state.seed = randomSeed();
  renderContract();
  renderContractsCatalog();
  renderSeed();
  updateUrl();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[char]);
}

function serializeBuild() {
  const params = new URLSearchParams();
  params.set('s', state.seed);
  params.set('h', state.hero?.key || '');
  params.set('i', state.items.map(item => item.key).join('.'));
  params.set('c', String(state.contractIndex));
  params.set('b', state.forceBootSlot ? '1' : '0');
  if (state.locked.size) params.set('l', [...state.locked].sort((a, b) => a - b).join(''));
  return params.toString();
}

function updateUrl() {
  if (!state.hero || state.items.length !== 6) return;
  const url = new URL(window.location.href);
  url.hash = serializeBuild();
  history.replaceState(null, '', url);
}

function parseBuildParams(raw) {
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const hero = state.heroByKey.get(params.get('h'));
  const items = String(params.get('i') || '')
    .split('.')
    .filter(Boolean)
    .map(key => state.itemsByKey[key]);
  const contractIndex = Number(params.get('c'));
  const seed = params.get('s') || randomSeed();
  const bootParam = params.get('b');
  const forceBootSlot = bootParam === null ? BOOT_KEY_SET.has(items[0]?.key) : bootParam !== '0';

  if (!hero || items.length !== 6 || items.some(item => !item)) return null;
  if (items.some(item => !isCompatible(item, hero))) return null;
  if (forceBootSlot && (!BOOT_KEY_SET.has(items[0].key) || items.slice(1).some(item => BOOT_KEY_SET.has(item.key)))) return null;

  const locks = new Set(String(params.get('l') || '')
    .split('')
    .map(Number)
    .filter(index => Number.isInteger(index) && index >= 0 && index < 6));

  return {
    seed,
    hero,
    items,
    contractIndex: Number.isInteger(contractIndex) && contractIndex >= 0 && contractIndex < CONTRACTS.length ? contractIndex : 0,
    locks,
    forceBootSlot
  };
}

function readSharedBuild() {
  return parseBuildParams(window.location.hash.replace(/^#/, ''));
}

function applySharedBuild(shared) {
  state.seed = shared.seed;
  state.hero = shared.hero;
  state.items = shared.items;
  state.contractIndex = shared.contractIndex;
  state.locked = shared.locks;
  state.forceBootSlot = shared.forceBootSlot;
  clearInspector();
  renderAll();
  updateUrl();
}

function importLobbyCode() {
  const raw = dom.lobbyCodeInput.value.trim();
  if (!raw) {
    showToast(t('toast.codeMissing'));
    return;
  }

  if (/^[A-Z0-9]{6,24}$/i.test(raw) && !raw.toUpperCase().startsWith('DCB1')) {
    generateFull(raw.toUpperCase(), { animate: true });
    dom.lobbyCodeInput.value = '';
    showToast(t('toast.seedApplied'));
    return;
  }

  const decoded = decodeBuildCode(raw);
  const shared = decoded ? parseBuildParams(decoded) : null;
  if (!shared) {
    showToast(t('toast.codeInvalid'));
    return;
  }

  applySharedBuild(shared);
  dom.lobbyCodeInput.value = '';
  showToast(t('toast.codeImported'));
}

function restoreOrGenerate() {
  const shared = readSharedBuild();
  if (shared) {
    applySharedBuild(shared);
  } else {
    const querySeed = new URLSearchParams(window.location.search).get('seed');
    generateFull(querySeed?.slice(0, 24).toUpperCase() || randomSeed(), { animate: false });
  }
}

async function copyText(text, successMessage) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  showToast(successMessage);
}

function showToast(message) {
  clearTimeout(toastTimer);
  dom.toast.textContent = message;
  dom.toast.classList.add('is-visible');
  toastTimer = setTimeout(() => dom.toast.classList.remove('is-visible'), 2400);
}

function initAnalytics() {
  const code = String(globalThis.DCB_ANALYTICS?.goatCounterCode || '').trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(code)) return;

  const dashboardUrl = `https://${code}.goatcounter.com/`;
  dom.statsLink.href = dashboardUrl;
  dom.statsLink.hidden = false;

  const script = document.createElement('script');
  script.async = true;
  script.src = 'https://gc.zgo.at/count.js';
  script.dataset.goatcounter = `https://${code}.goatcounter.com/count`;
  document.head.append(script);
}

function bindEvents() {
  dom.generateButton.addEventListener('click', () => generateFull());
  dom.rerollUnlockedButton.addEventListener('click', rerollUnlocked);
  dom.rerollHeroButton.addEventListener('click', rerollHero);
  dom.rerollContractButton.addEventListener('click', rerollContract);
  dom.showContractsButton.addEventListener('click', () => {
    renderContractsCatalog();
    dom.contractsDialog.showModal();
  });
  dom.closeContractsButton.addEventListener('click', () => dom.contractsDialog.close());
  dom.contractsDialog.addEventListener('click', event => {
    if (event.target === dom.contractsDialog) dom.contractsDialog.close();
  });
  dom.releaseNotesButton.addEventListener('click', () => dom.releaseNotesDialog.showModal());
  dom.closeReleaseNotesButton.addEventListener('click', () => dom.releaseNotesDialog.close());
  dom.releaseNotesDialog.addEventListener('click', event => {
    if (event.target === dom.releaseNotesDialog) dom.releaseNotesDialog.close();
  });
  dom.forceBootSlotToggle.addEventListener('change', event => setForceBootSlot(event.currentTarget.checked));
  dom.scepterSlotButton.addEventListener('click', () => inspectItem('ultimate_scepter'));
  dom.shardSlotButton.addEventListener('click', () => inspectItem('aghanims_shard'));
  dom.copyLobbyCodeButton.addEventListener('click', () => copyText(currentLobbyCode(), t('toast.codeCopied')));
  dom.importLobbyCodeButton.addEventListener('click', importLobbyCode);
  dom.lobbyCodeInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') importLobbyCode();
  });
  dom.shareButton.addEventListener('click', () => copyText(window.location.href, t('toast.linkCopied')));
}

async function bootstrap() {
  initI18n();
  bindEvents();
  initAnalytics();
  setDataState('', t('data.loading'));

  const metaPromise = loadMeta();

  try {
    const remote = await loadRemoteData();
    state.heroes = normalizeHeroes(remote.heroes);
    state.itemsByKey = normalizeItems(remote.items);
    state.dataSourceName = remote.sourceName;
    state.usingFallback = false;
    setDataState('ready', t('data.ready'));
  } catch (error) {
    state.heroes = FALLBACK_HEROES;
    state.itemsByKey = normalizeItems(FALLBACK_ITEMS);
    state.usingFallback = true;
    setDataState('fallback', t('data.fallback'));
    console.warn('Remote Dota data unavailable, fallback enabled:', error);
  }

  applyMeta(await metaPromise);

  if (!state.heroes.length) state.heroes = FALLBACK_HEROES;
  if (!Object.keys(state.itemsByKey).length) state.itemsByKey = normalizeItems(FALLBACK_ITEMS);

  for (const [key, item] of Object.entries(FALLBACK_ITEMS)) {
    if (!state.itemsByKey[key]) state.itemsByKey[key] = { ...item, key };
  }

  state.heroByKey = new Map(state.heroes.map(hero => [hero.key, hero]));
  state.itemPool = buildItemPool(state.itemsByKey);
  state.ready = true;
  restoreOrGenerate();
  await initRanked({ onMessage: showToast });
  initStats();
  window.addEventListener('dcb:localechange', () => {
    applyTranslations();
    applyMeta(state.meta);
    setDataState(state.usingFallback ? 'fallback' : 'ready', t(state.usingFallback ? 'data.fallback' : 'data.ready'));
    dom.siteVersion.title = dom.siteVersion.textContent === 'dev'
      ? t('version.unavailable')
      : t('version.title', { version: dom.siteVersion.textContent.replace(/^v/, '') });
    if (state.ready) renderAll();
  });
}

bootstrap();
