'use strict';

const CONFIG = {
  patch: '7.41e',
  rapierChance: 0.0035,
  steamCdn: 'https://cdn.cloudflare.steamstatic.com',
  sources: [
    {
      heroes: 'https://cdn.jsdelivr.net/gh/odota/dotaconstants@master/build/heroes.json',
      items: 'https://cdn.jsdelivr.net/gh/odota/dotaconstants@master/build/items.json'
    },
    {
      heroes: 'https://raw.githubusercontent.com/odota/dotaconstants/master/build/heroes.json',
      items: 'https://raw.githubusercontent.com/odota/dotaconstants/master/build/items.json'
    }
  ]
};

const ITEM_POOL_KEYS = [
  'phase_boots', 'power_treads', 'arcane_boots', 'tranquil_boots', 'travel_boots', 'travel_boots_2',
  'guardian_greaves', 'boots_of_bearing',
  'blink', 'overwhelming_blink', 'swift_blink', 'arcane_blink',
  'black_king_bar', 'sphere', 'lotus_orb', 'aeon_disk', 'blade_mail', 'heart', 'shivas_guard',
  'assault', 'bloodstone', 'pipe', 'crimson_guard', 'vanguard', 'consecrated_wraps',
  'satanic', 'skadi', 'butterfly', 'monkey_king_bar', 'greater_crit', 'desolator', 'silver_edge',
  'invis_sword', 'radiance', 'mjollnir', 'maelstrom', 'moon_shard', 'nullifier',
  'diffusal_blade', 'disperser', 'manta', 'sange_and_yasha', 'yasha_and_kaya', 'kaya_and_sange',
  'heavens_halberd', 'armlet', 'mask_of_madness', 'falcon_blade', 'mage_slayer',
  'orchid', 'bloodthorn', 'witch_blade', 'parasma', 'angels_demise', 'phylactery', 'ethereal_blade',
  'dagon_5', 'octarine_core', 'refresher', 'sheepstick', 'wind_waker', 'cyclone', 'rod_of_atos',
  'gleipnir', 'revenants_brooch', 'veil_of_discord',
  'force_staff', 'glimmer_cape', 'solar_crest', 'pavise', 'holy_locket', 'mekansm',
  'spirit_vessel', 'essence_distiller', 'crellas_crozier',
  'hand_of_midas', 'helm_of_the_dominator', 'helm_of_the_overlord',
  'battlefury', 'basher', 'abyssal_blade', 'echo_sabre', 'harpoon',
  'dragon_lance', 'hurricane_pike', 'specialists_array', 'hydras_breath'
];

const BOOT_KEYS = [
  'phase_boots', 'power_treads', 'arcane_boots', 'tranquil_boots',
  'travel_boots', 'travel_boots_2', 'guardian_greaves', 'boots_of_bearing'
];
const BOOT_KEY_SET = new Set(BOOT_KEYS);
const RANGED_ONLY = new Set(['dragon_lance', 'hurricane_pike', 'specialists_array', 'hydras_breath']);
const MELEE_ONLY = new Set(['battlefury', 'basher', 'abyssal_blade', 'echo_sabre', 'harpoon']);
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
const ATTR_RU = { str: 'СИЛА', agi: 'ЛОВКОСТЬ', int: 'ИНТЕЛЛЕКТ', all: 'УНИВЕРСАЛ' };
const ATTR_GLYPH = { str: 'S', agi: 'A', int: 'I', all: 'U' };
const QUALITY_RU = {
  common: 'ОБЫЧНЫЙ', uncommon: 'НЕОБЫЧНЫЙ', rare: 'РЕДКИЙ', epic: 'ЭПИЧЕСКИЙ', artifact: 'АРТЕФАКТ'
};

const CONTRACTS = [
  {
    name: 'Жадный Аганим',
    description: 'Aghanim\'s Scepter должен стать одним из первых трёх полностью собранных крупных предметов.'
  },
  {
    name: 'Осколок судьбы',
    description: 'Купи Aghanim\'s Shard при первой безопасной возможности после 15:00 — до следующего предмета дороже 3000.'
  },
  {
    name: 'Без возврата',
    description: 'Нельзя продавать или разбирать полностью собранные предметы из выданной шестёрки.'
  },
  {
    name: 'Лестница нетворса',
    description: 'Завершай основные предметы по возрастанию цены: от самого дешёвого к самому дорогому.'
  },
  {
    name: 'Последняя роскошь',
    description: 'Самый дорогой предмет сборки разрешено завершить только шестым.'
  },
  {
    name: 'Чистый Quick Buy',
    description: 'В Quick Buy может находиться только текущий предмет и его компоненты — без заготовок на следующий.'
  },
  {
    name: 'Рошан решает',
    description: 'После первого убийства Рошана вашей командой следующая крупная покупка — Аганим или шард.'
  },
  {
    name: 'Компонент долга',
    description: 'После каждой второй смерти первым делом купи компонент самого дешёвого незавершённого предмета.'
  },
  {
    name: 'Шард до роскоши',
    description: 'Aghanim\'s Shard должен быть куплен раньше любого предмета стоимостью 5000 золота и выше.'
  },
  {
    name: 'Неподвижный слот',
    description: 'Первый завершённый предмет занимает выбранный слот инвентаря до конца матча и не перемещается.'
  },
  {
    name: 'Один путь',
    description: 'После покупки первого компонента предмета нельзя переключаться на сборку другого крупного предмета.'
  },
  {
    name: 'Налог на камбэк',
    description: 'После выигранной драки с тремя и более убийствами потрать доступное золото только на выданную сборку.'
  }
];

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
  lore: 'Резервное описание предмета. При подключении к сети загрузятся актуальные игровые данные.'
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
  seedCode: document.querySelector('#seedCode'),
  copySeedButton: document.querySelector('#copySeedButton'),
  shareButton: document.querySelector('#shareButton'),
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
  usingFallback: false,
  ready: false
};

let toastTimer = null;

dom.patchLabel.textContent = CONFIG.patch;

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

function normalizeItems(raw) {
  const output = {};
  for (const [key, item] of Object.entries(raw || {})) {
    if (!item || !item.dname || !item.img) continue;
    output[key] = { ...item, key };
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
      return { heroes, items };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Не удалось загрузить данные');
}

function setDataState(mode, text) {
  dom.dataState.className = `data-state ${mode ? `is-${mode}` : ''}`.trim();
  dom.dataState.innerHTML = `<i></i>${text}`;
}

function xmur3(text) {
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i += 1) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function seedHash() {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

function mulberry32(seed) {
  return function random() {
    let value = seed += 0x6D2B79F5;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function seededRandom(seedText) {
  const hash = xmur3(seedText);
  return mulberry32(hash());
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

function pick(list, rng) {
  return list[Math.floor(rng() * list.length)];
}

function shuffle(list, rng) {
  const result = [...list];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function isCompatible(item, hero) {
  if (!item || !hero) return false;
  if (hero.attack_type === 'Ranged' && MELEE_ONLY.has(item.key)) return false;
  if (hero.attack_type === 'Melee' && RANGED_ONLY.has(item.key)) return false;
  return true;
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
  const rng = seededRandom(`build:${seed}:${state.forceBootSlot ? 'boot' : 'free'}`);
  const hero = pick(state.heroes, rng);
  const items = [];
  const used = new Set();

  if (state.forceBootSlot) {
    const boots = bootPool(hero);
    const boot = pick(boots, rng);
    if (boot) {
      items.push(boot);
      used.add(boot.key);
    }
  }

  const pool = shuffle(compatiblePool(hero, used, { excludeBoots: state.forceBootSlot }), rng);
  items.push(...pool.slice(0, 6 - items.length));

  if (state.itemsByKey.rapier && rng() < CONFIG.rapierChance && items.length === 6) {
    const firstAllowedIndex = state.forceBootSlot ? 1 : 0;
    const index = firstAllowedIndex + Math.floor(rng() * (items.length - firstAllowedIndex));
    items[index] = state.itemsByKey.rapier;
  }

  return {
    hero,
    items,
    contractIndex: Math.floor(rng() * CONTRACTS.length)
  };
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
  if (replacedLocked) showToast('Несовместимые закреплённые предметы заменены под нового героя.');
}

function rerollUnlocked() {
  if (!state.ready) return;
  const unlocked = [0, 1, 2, 3, 4, 5].filter(index => !state.locked.has(index));
  if (!unlocked.length) {
    showToast('Все шесть слотов закреплены. Сними хотя бы один замок.');
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
  showToast('Первый слот закреплён за случайным сапогом.');
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
  dom.heroAttackType.textContent = hero.attack_type === 'Ranged' ? 'ДАЛЬНИЙ БОЙ' : 'БЛИЖНИЙ БОЙ';
  dom.heroAttackType.style.color = hero.attack_type === 'Ranged' ? '#6ea9c7' : '#b65e4c';
  dom.heroAttribute.dataset.attr = hero.primary_attr || 'all';
  dom.heroAttribute.textContent = ATTR_GLYPH[hero.primary_attr] || 'U';
  dom.heroAttribute.title = ATTR_RU[hero.primary_attr] || 'УНИВЕРСАЛ';
  dom.heroRoles.innerHTML = (hero.roles || []).slice(0, 5)
    .map(role => `<span class="role-chip">${ROLE_RU[role] || role}</span>`)
    .join('');
  dom.heroRange.textContent = String(hero.attack_range ?? '—');
  dom.heroSpeed.textContent = String(hero.move_speed ?? '—');
  dom.heroAttrText.textContent = ATTR_RU[hero.primary_attr] || 'УНИВЕРСАЛ';
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
    cost.textContent = Number(item.cost || 0).toLocaleString('ru-RU');
    node.dataset.index = String(index);
    node.setAttribute('aria-label', `${item.dname}, ${item.cost || 0} золота`);

    if (state.locked.has(index)) node.classList.add('is-locked');
    if (state.selectedIndex === index) node.classList.add('is-selected');
    if (item.key === 'rapier') node.classList.add('is-rapier');

    if (RANGED_ONLY.has(item.key)) {
      restriction.textContent = 'RNG';
      restriction.classList.add('is-ranged');
      restriction.title = 'Только для героев дальнего боя';
    } else if (MELEE_ONLY.has(item.key)) {
      restriction.textContent = 'MEL';
      restriction.classList.add('is-melee');
      restriction.title = 'Только для героев ближнего боя';
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
  if (item?.key?.startsWith('recipe_')) return 'Рецепт, необходимый для завершения предмета.';
  const ability = Array.isArray(item.abilities) ? item.abilities[0] : null;
  return plainText(ability?.description || item.lore || item.notes || 'Описание недоступно.');
}

function recipeComponents(item) {
  const keys = Array.isArray(item?.components) ? [...item.components] : [];
  const recipeKey = item?.key ? `recipe_${item.key}` : '';
  const recipe = recipeKey ? state.itemsByKey[recipeKey] : null;
  if (recipe && Number(recipe.cost) > 0 && !keys.includes(recipeKey)) keys.push(recipeKey);
  return keys.map(key => state.itemsByKey[key]).filter(Boolean);
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
        Выбери предмет, чтобы посмотреть детали и дерево сборки. Компоненты внутри тоже можно открывать.
      </div>`;
    return;
  }

  const isRecipe = item.key.startsWith('recipe_');
  const quality = isRecipe ? 'component' : (item.qual || 'common');
  const qualityLabel = isRecipe ? 'РЕЦЕПТ' : (QUALITY_RU[quality] || 'ПРЕДМЕТ');
  const tags = [];
  if (RANGED_ONLY.has(item.key)) tags.push('только дальний бой');
  if (MELEE_ONLY.has(item.key)) tags.push('только ближний бой');
  if (BOOT_KEY_SET.has(item.key)) tags.push('сапог');
  if (Array.isArray(item.abilities)) tags.push(...item.abilities.slice(0, 2).map(ability => ability.title).filter(Boolean));
  if (state.selectedIndex !== null && state.locked.has(state.selectedIndex) && state.inspectorRootKey === item.key) {
    tags.push('слот закреплён');
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
      <section class="recipe-panel" aria-label="Компоненты предмета">
        <div class="recipe-panel__head">
          <div><span>ДЕРЕВО СБОРКИ</span><strong>Собирается из</strong></div>
          <small>${componentTotal.toLocaleString('ru-RU')} золота</small>
        </div>
        <div class="recipe-components">
          ${components.map(component => `
            <button class="recipe-component" type="button" data-component-key="${escapeHtml(component.key)}" title="Открыть ${escapeHtml(component.dname)}">
              <span class="recipe-component__image"><img src="${assetUrl(component.img)}" alt=""></span>
              <span class="recipe-component__copy"><strong>${escapeHtml(component.dname)}</strong><small>${Number(component.cost || 0).toLocaleString('ru-RU')}</small></span>
              <span class="recipe-component__arrow" aria-hidden="true">›</span>
            </button>`).join('')}
        </div>
      </section>`
    : `
      <div class="recipe-leaf">
        <span>БАЗОВЫЙ КОМПОНЕНТ</span>
        Этот предмет не собирается из других предметов.
      </div>`;

  dom.itemInspector.innerHTML = `
    <nav class="recipe-breadcrumbs" aria-label="Путь по рецепту">
      ${path.length > 1 ? '<button class="recipe-back" type="button" data-recipe-back aria-label="Назад">←</button>' : ''}
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
      <div class="inspector-price">${Number(item.cost || 0).toLocaleString('ru-RU')}</div>
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
  dom.buildCost.textContent = `${total.toLocaleString('ru-RU')} ЗОЛОТА`;
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
  dom.contractName.textContent = contract.name;
  dom.contractDescription.textContent = contract.description;
}

function renderSeed() {
  dom.seedCode.textContent = state.seed || '--------';
}

function renderAll() {
  renderHero();
  renderInventory();
  renderInspector();
  renderCost();
  renderOptions();
  renderUpgrades();
  renderContract();
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

function readSharedBuild() {
  const raw = window.location.hash.replace(/^#/, '');
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

function restoreOrGenerate() {
  const shared = readSharedBuild();
  if (shared) {
    state.seed = shared.seed;
    state.hero = shared.hero;
    state.items = shared.items;
    state.contractIndex = shared.contractIndex;
    state.locked = shared.locks;
    state.forceBootSlot = shared.forceBootSlot;
    clearInspector();
    renderAll();
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

function bindEvents() {
  dom.generateButton.addEventListener('click', () => generateFull());
  dom.rerollUnlockedButton.addEventListener('click', rerollUnlocked);
  dom.rerollHeroButton.addEventListener('click', rerollHero);
  dom.rerollContractButton.addEventListener('click', rerollContract);
  dom.forceBootSlotToggle.addEventListener('change', event => setForceBootSlot(event.currentTarget.checked));
  dom.scepterSlotButton.addEventListener('click', () => inspectItem('ultimate_scepter'));
  dom.shardSlotButton.addEventListener('click', () => inspectItem('aghanims_shard'));
  dom.copySeedButton.addEventListener('click', () => copyText(state.seed, 'Код челленджа скопирован.'));
  dom.shareButton.addEventListener('click', () => copyText(window.location.href, 'Ссылка на точную сборку скопирована.'));
}

async function bootstrap() {
  bindEvents();
  setDataState('', 'загрузка данных');

  try {
    const remote = await loadRemoteData();
    state.heroes = normalizeHeroes(remote.heroes);
    state.itemsByKey = normalizeItems(remote.items);
    state.usingFallback = false;
    setDataState('ready', 'актуальные данные');
  } catch (error) {
    state.heroes = FALLBACK_HEROES;
    state.itemsByKey = normalizeItems(FALLBACK_ITEMS);
    state.usingFallback = true;
    setDataState('fallback', 'резервные данные');
    console.warn('Remote Dota data unavailable, fallback enabled:', error);
  }

  if (!state.heroes.length) state.heroes = FALLBACK_HEROES;
  if (!Object.keys(state.itemsByKey).length) state.itemsByKey = normalizeItems(FALLBACK_ITEMS);

  for (const [key, item] of Object.entries(FALLBACK_ITEMS)) {
    if (!state.itemsByKey[key]) state.itemsByKey[key] = { ...item, key };
  }

  state.heroByKey = new Map(state.heroes.map(hero => [hero.key, hero]));
  state.itemPool = buildItemPool(state.itemsByKey);
  state.ready = true;
  restoreOrGenerate();
}

bootstrap();
