import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import {
  getRoundwood,
  postReceive,
  postReceiveBrus,
  postReceiveFromLabel,
  postConsume,
  patchStockItem,
  deleteStockItem,
  deleteBrusStockItem,
  deleteClearStock,
} from '../controllers/roundwoodController.js'

const router = Router()

router.get('/', requireAuth, getRoundwood)
router.post('/receive', requireAuth, postReceive)
router.post('/brus/receive', requireAuth, postReceiveBrus)
router.delete('/brus/stock/:itemId', requireAuth, deleteBrusStockItem)
router.post('/receive-from-label', requireAuth, postReceiveFromLabel)
router.post('/consume', requireAuth, postConsume)
router.patch('/stock/:logId', requireAuth, patchStockItem)
router.delete('/stock/:logId', requireAuth, deleteStockItem)
router.delete('/stock', requireAuth, deleteClearStock)

export default router
