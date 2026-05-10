import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { requireAdmin } from '../middleware/requireAdmin.js'
import {
  createUser,
  createSalaryManual,
  deleteUser,
  getSalaryRatesConfig,
  getSalaryReport,
  listSalaryManual,
  listUsers,
  listWorkersDirectory,
  putSalaryRatesConfig,
  updateUser,
} from '../controllers/usersController.js'

function requireForemanOrAdmin(req, res, next) {
  if (req.user?.role === 'foreman' || req.user?.role === 'admin' || req.user?.role === 'super_admin') return next()
  return res.status(403).json({ error: 'Потрібні права бригадира або адміністратора' })
}

const router = Router()

router.get('/workers', requireAuth, requireForemanOrAdmin, listWorkersDirectory)
router.get('/salary-rates', requireAuth, getSalaryRatesConfig)
router.put('/salary-rates', requireAuth, requireAdmin, putSalaryRatesConfig)
router.get('/salary-report', requireAuth, requireAdmin, getSalaryReport)
router.get('/salary-manual', requireAuth, listSalaryManual)
router.post('/salary-manual', requireAuth, requireAdmin, createSalaryManual)
router.get('/', requireAuth, requireAdmin, listUsers)
router.post('/', requireAuth, requireAdmin, createUser)
router.put('/:id', requireAuth, requireAdmin, updateUser)
router.delete('/:id', requireAuth, requireAdmin, deleteUser)

export default router
