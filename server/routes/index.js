import { Router } from 'express'
import authRoutes from './authRoutes.js'
import tasksRoutes from './tasksRoutes.js'
import labelRoutes from './labelRoutes.js'
import roundwoodRoutes from './roundwoodRoutes.js'
import usersRoutes from './usersRoutes.js'

const router = Router()

router.use('/auth', authRoutes)
router.use('/tasks', tasksRoutes)
router.use('/labels', labelRoutes)
router.use('/roundwood', roundwoodRoutes)
router.use('/users', usersRoutes)

export default router
