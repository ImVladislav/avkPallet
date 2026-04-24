import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import {
  listTasks,
  createTask,
  updateTask,
  deleteTask,
  patchTask,
  recordBandCut,
  recordStripSawCut,
  patchStripSawRemainder,
} from '../controllers/tasksController.js'

const router = Router()

router.get('/', requireAuth, listTasks)
router.post('/', requireAuth, createTask)
router.put('/:id', requireAuth, updateTask)
router.delete('/:id', requireAuth, deleteTask)
router.patch('/:id', requireAuth, patchTask)
router.post('/:id/band-cut', requireAuth, recordBandCut)
router.post('/:id/strip-saw/cut', requireAuth, recordStripSawCut)
router.patch('/:id/strip-saw/remainder', requireAuth, patchStripSawRemainder)

export default router
