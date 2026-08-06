export const MODIFIERS = [
  {
    id: 'no-buyback', name: 'Одна жизнь — один план', multiplier: 1.08,
    description: 'Победи без единого выкупа.'
  },
  {
    id: 'teamfight', name: 'В каждой драке', multiplier: 1.12,
    description: 'Поучаствуй минимум в 50% убийств своей команды.'
  },
  {
    id: 'tower-pressure', name: 'Осадный контракт', multiplier: 1.15,
    description: 'Нанеси башням не меньше 3000 урона (2000 в Turbo).'
  },
  {
    id: 'rune-control', name: 'Хозяин рун', multiplier: 1.1,
    description: 'Подбери минимум 6 рун (4 в Turbo).'
  },
  {
    id: 'clean-kda', name: 'Чистое исполнение', multiplier: 1.15,
    description: 'Закончи победу с KDA не ниже 4 и участием минимум в 35% убийств команды.'
  },
  {
    id: 'camp-stacker', name: 'Экономика команды', multiplier: 1.12, roles: ['Support'],
    description: 'Сделай минимум 3 стака лагерей (2 в Turbo).'
  },
  {
    id: 'vision', name: 'Поле зрения', multiplier: 1.15, roles: ['Support'],
    description: 'Поставь суммарно минимум 8 observer/sentry вардов (6 в Turbo).'
  },
  {
    id: 'smoke-operation', name: 'Дымовая операция', multiplier: 1.12, roles: ['Support'],
    description: 'Купи и используй минимум 2 Smoke of Deceit (1 в Turbo).'
  },
  {
    id: 'aghanim-early', name: 'Приоритет Аганима', multiplier: 1.15,
    description: "Заверши Aghanim's Scepter раньше третьего предмета выданной сборки."
  },
  {
    id: 'shard-before-luxury', name: 'Шард до роскоши', multiplier: 1.1, requiresLuxury: true,
    description: "Купи Aghanim's Shard раньше любого выданного предмета стоимостью 5000 золота и выше."
  }
];

export function eligibleModifiers({ hero, items }) {
  const roles = new Set(hero?.roles || []);
  return MODIFIERS.filter(modifier =>
    (!modifier.roles || modifier.roles.some(role => roles.has(role)))
    && (!modifier.requiresLuxury || items.some(item => Number(item.cost) >= 5000))
  );
}

export function modifierById(id) {
  return MODIFIERS.find(modifier => modifier.id === id) || null;
}
