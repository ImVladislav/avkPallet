import { verifyToken } from '../helpers/jwt.js'
import { readJson } from '../helpers/jsonStore.js'
import { USERS_FILE } from '../helpers/paths.js'
import { publicUser } from '../helpers/userTabs.js'

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Потрібна авторизація' })
  }
  const token = header.slice(7)
  try {
    const payload = verifyToken(token)
    const users = await readJson(USERS_FILE, [])
    const row = users.find((u) => String(u.id) === String(payload.sub))
    const tabs = row ? publicUser(row).tabs : []
    req.user = {
      sub: payload.sub,
      username: payload.username,
      role: payload.role,
      tabs,
    }
    next()
  } catch {
    return res.status(401).json({ error: 'Недійсний або прострочений токен' })
  }
}
