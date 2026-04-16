/**
 * Базовий URL API. У production зазвичай порожньо — той самий хост, що й фронт (/api).
 * У `vite dev` проксі /api інколи повертає 404 (Windows/IPv6) — тоді йдемо напряму на порт бекенду.
 */
export function apiUrl(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`
  const fromEnv = import.meta.env.VITE_API_BASE_URL
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    return `${fromEnv.replace(/\/$/, '')}${p}`
  }
  if (import.meta.env.DEV) {
    return `http://127.0.0.1:3001${p}`
  }
  return p
}
