export function xmur3(text) {
  let hash = 1779033703 ^ text.length;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 3432918353);
    hash = (hash << 13) | (hash >>> 19);
  }
  return function seedHash() {
    hash = Math.imul(hash ^ (hash >>> 16), 2246822507);
    hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
    return (hash ^= hash >>> 16) >>> 0;
  };
}

export function mulberry32(seed) {
  return function random() {
    let value = seed += 0x6D2B79F5;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededRandom(seedText) {
  return mulberry32(xmur3(seedText)());
}

export function pick(list, random) {
  return list[Math.floor(random() * list.length)];
}

export function shuffle(list, random) {
  const result = [...list];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

export function generateBuild({
  seed,
  forceBootSlot,
  heroes,
  itemPool,
  itemsByKey,
  bootKeys,
  isCompatible,
  modifierCount,
  rapierChance
}) {
  const random = seededRandom(`build:${seed}:${forceBootSlot ? 'boot' : 'free'}`);
  const hero = pick(heroes, random);
  const items = [];
  const used = new Set();
  const bootKeySet = new Set(bootKeys);

  if (forceBootSlot) {
    const boots = bootKeys
      .map(key => itemsByKey[key])
      .filter(item => item && isCompatible(item, hero));
    const boot = pick(boots, random);
    if (boot) {
      items.push(boot);
      used.add(boot.key);
    }
  }

  const pool = shuffle(itemPool.filter(item => (
    isCompatible(item, hero)
    && !used.has(item.key)
    && (!forceBootSlot || !bootKeySet.has(item.key))
  )), random);
  items.push(...pool.slice(0, 6 - items.length));

  if (itemsByKey.rapier && random() < rapierChance && items.length === 6) {
    const firstAllowedIndex = forceBootSlot ? 1 : 0;
    const index = firstAllowedIndex + Math.floor(random() * (items.length - firstAllowedIndex));
    items[index] = itemsByKey.rapier;
  }

  return {
    hero,
    items,
    modifierIndex: Math.floor(random() * modifierCount)
  };
}
