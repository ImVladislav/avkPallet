/**
 * Базовий URL API.
 * - У dev без змінної: http://127.0.0.1:3001 (див. vite proxy).
 * - У production: змінна VITE_API_BASE_URL (на Vercel — задати в налаштуваннях проєкту).
 * - Якщо змінної немає: публічний бекенд цього деплою (Render), щоб фронт на Vercel працював без додаткового env.
 *   Для свого хостингу задайте VITE_API_BASE_URL або змініть PROD_API_FALLBACK нижче.
 */
const PROD_API_FALLBACK = 'https://avkpallet-back.onrender.com'

export function apiUrl(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`
  const fromEnv = import.meta.env.VITE_API_BASE_URL
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    return `${fromEnv.replace(/\/$/, '')}${p}`
  }
  if (import.meta.env.DEV) {
    return `http://127.0.0.1:3001${p}`
  }
  return `${PROD_API_FALLBACK.replace(/\/$/, '')}${p}`
}
