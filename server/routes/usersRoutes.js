import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { requireAdmin } from '../middleware/requireAdmin.js'
import { createUser, deleteUser, listUsers, updateUser } from '../controllers/usersController.js'

const router = Router()

router.get('/', requireAuth, requireAdmin, listUsers)
router.post('/', requireAuth, requireAdmin, createUser)
router.put('/:id', requireAuth, requireAdmin, updateUser)
router.delete('/:id', requireAuth, requireAdmin, deleteUser)

export default router
