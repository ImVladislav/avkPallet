/** Обгортка навколо fetch з зрозумілими повідомленнями для прод-кросc-домену. */
export async function fetchApi(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init)
  } catch (e) {
    if (e instanceof TypeError) {
      throw new Error(
        'Не вдалося зв’язатися з сервером. Можливі причини: немає інтернету, на Vercel не задано змінну VITE_API_BASE_URL (URL бекенду, наприклад https://avkpallet-back.onrender.com), або бекенд не дозволяє ваш сайт у CORS (див. CORS_ORIGINS на Render).',
      )
    }
    throw e
  }
}

export async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text()
  if (!text) return {} as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(
      `Сервер повернув не JSON (код ${res.status}). Ймовірно, запит пішов не на API: на Vercel має бути VITE_API_BASE_URL на адресу Render без / на кінці.`,
    )
  }
}
