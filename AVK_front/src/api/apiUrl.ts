/**
 * Базовий URL API.
 * - У dev без змінної: http://127.0.0.1:3001 (див. vite proxy).
 * - У production: VITE_API_BASE_URL (на Vercel — Project → Settings → Environment Variables).
 *   У змінних середовища Vercel пріоритет вищий за файл .env.production у репо; якщо там вказано
 *   http://127.0.0.1:3001, у прод-збірці все одно підставляється локальний хост — так не робіть.
 * - У production, якщо VITE_API_BASE_URL вказує на localhost — ігноруємо й беремо PROD_API_FALLBACK.
 * - Якщо змінної немає: PROD_API_FALLBACK (Render для цього деплою).
 */
const PROD_API_FALLBACK = 'https://avkpallet-back.onrender.com'

/** На Vercel інколи випадково задають VITE_API_BASE_URL=http://127.0.0.1:3001 — це перебиває .env.production і потрапляє в збірку. */
function looksLikeLocalDevHost(base: string): boolean {
  try {
    const u = new URL(base.includes('://') ? base : `https://${base}`)
    const h = u.hostname.toLowerCase()
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]'
  } catch {
    return false
  }
}

export function apiUrl(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`
  const fromEnv = import.meta.env.VITE_API_BASE_URL
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    const trimmed = fromEnv.replace(/\/$/, '')
    if (import.meta.env.PROD && looksLikeLocalDevHost(trimmed)) {
      return `${PROD_API_FALLBACK.replace(/\/$/, '')}${p}`
    }
    return `${trimmed}${p}`
  }
  if (import.meta.env.DEV) {
    return `http://127.0.0.1:3001${p}`
  }
  return `${PROD_API_FALLBACK.replace(/\/$/, '')}${p}`
}
