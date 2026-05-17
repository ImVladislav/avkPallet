/**
 * Маршрути-підсторінки: ціль для кнопки «Назад» у шапці (завжди одне місце в UI).
 * Додавайте нові вкладені шляхи сюди, щоб навігація лишалась передбачуваною.
 */
export function subPageBackTarget(pathname: string): { to: string; title: string } | null {
  const p = pathname.replace(/\/+$/, '') || '/'

  if (p === '/users/new' || p === '/users/salary') {
    return { to: '/users', title: 'Назад до списку працівників' }
  }

  if (/^\/users\/[^/]+\/edit$/u.test(p)) {
    return { to: '/users', title: 'Назад до списку працівників' }
  }

  return null
}
