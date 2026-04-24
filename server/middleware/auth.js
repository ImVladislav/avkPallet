import { verifyToken } from '../helpers/jwt.js'

export function requireAuth(req, res, next) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Потрібна авторизація' })
  }
  const token = header.slice(7)
  try {
    const payload = verifyToken(token)
    req.user = {
      sub: payload.sub,
      username: payload.username,
      role: payload.role,
    }
    next()
  } catch {
    return res.status(401).json({ error: 'Недійсний або прострочений токен' })
  }
}
