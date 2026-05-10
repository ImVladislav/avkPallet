import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'

const router = Router()

router.get('/:labelNumber', requireAuth, async (req, res) => {
  const label = Math.round(Number(req.params.labelNumber))
  if (!Number.isFinite(label) || label <= 0) {
    return res.status(400).json({ error: 'Вкажіть коректний номер бірки' })
  }

  try {
    const upstreamRes = await fetch(`https://macvpn.cloud/log/${encodeURIComponent(String(label))}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })
    const data = await upstreamRes.json().catch(() => ({}))
    if (!upstreamRes.ok) {
      const upstreamError =
        typeof data?.error === 'string' && data.error
          ? data.error
          : `Помилка сервісу бірок (${upstreamRes.status})`
      return res.status(502).json({ error: upstreamError })
    }
    return res.json(data)
  } catch {
    return res.status(502).json({ error: 'Не вдалося отримати дані бірки' })
  }
})

export default router
