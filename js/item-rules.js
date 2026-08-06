export const ITEM_POOL_KEYS = [
  'phase_boots', 'power_treads', 'arcane_boots', 'tranquil_boots', 'travel_boots', 'travel_boots_2',
  'guardian_greaves', 'boots_of_bearing', 'blink', 'overwhelming_blink', 'swift_blink', 'arcane_blink',
  'black_king_bar', 'sphere', 'lotus_orb', 'aeon_disk', 'blade_mail', 'heart', 'shivas_guard',
  'assault', 'bloodstone', 'pipe', 'crimson_guard', 'vanguard', 'consecrated_wraps', 'satanic',
  'skadi', 'butterfly', 'monkey_king_bar', 'greater_crit', 'desolator', 'silver_edge', 'invis_sword',
  'radiance', 'mjollnir', 'maelstrom', 'moon_shard', 'nullifier', 'diffusal_blade', 'disperser',
  'manta', 'sange_and_yasha', 'yasha_and_kaya', 'kaya_and_sange', 'heavens_halberd', 'armlet',
  'mask_of_madness', 'falcon_blade', 'mage_slayer', 'orchid', 'bloodthorn', 'witch_blade', 'parasma',
  'angels_demise', 'phylactery', 'ethereal_blade', 'dagon_5', 'octarine_core', 'refresher',
  'sheepstick', 'wind_waker', 'cyclone', 'rod_of_atos', 'gleipnir', 'revenants_brooch',
  'veil_of_discord', 'force_staff', 'glimmer_cape', 'solar_crest', 'pavise', 'holy_locket',
  'mekansm', 'spirit_vessel', 'essence_distiller', 'crellas_crozier', 'hand_of_midas',
  'helm_of_the_dominator', 'helm_of_the_overlord', 'battlefury', 'basher', 'abyssal_blade',
  'echo_sabre', 'harpoon', 'dragon_lance', 'hurricane_pike', 'specialists_array', 'hydras_breath'
];

export const BOOT_KEYS = [
  'phase_boots', 'power_treads', 'arcane_boots', 'tranquil_boots',
  'travel_boots', 'travel_boots_2', 'guardian_greaves', 'boots_of_bearing'
];

export const BOOT_KEY_SET = new Set(BOOT_KEYS);

export const ITEM_KEY_ALIASES = Object.freeze({
  battlefury: 'bfury',
  parasma: 'devastator',
  gleipnir: 'gungir'
});

export const RANGED_ONLY = new Set(['dragon_lance', 'hurricane_pike', 'specialists_array', 'hydras_breath']);
export const MELEE_ONLY = new Set(['battlefury', 'basher', 'abyssal_blade', 'echo_sabre', 'harpoon']);

export function isItemCompatible(item, hero) {
  if (!item || !hero) return false;
  if (hero.attack_type === 'Ranged' && MELEE_ONLY.has(item.key)) return false;
  if (hero.attack_type === 'Melee' && RANGED_ONLY.has(item.key)) return false;
  return true;
}
