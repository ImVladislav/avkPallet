/**
 * Після requireAuth: лише role === 'admin'.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Потрібні права адміністратора' })
  }
  next()
}
