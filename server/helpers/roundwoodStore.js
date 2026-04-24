import { readJson, writeJson } from './jsonStore.js'
import { ROUNDWOOD_FILE } from './paths.js'

/**
 * @typedef {{ id: number, radius: number, length: number, createdAt: string, volumeM3?: number }} RoundwoodStockItem
 */

/**
 * @typedef {{
 *   id: string,
 *   kind: 'received' | 'receive_cancelled' | 'band_consumed' | 'stock_updated' | 'stock_cleared',
 *   at: string,
 *   recordedBy: { username: string, sub?: string },
 *   logId?: number,
 *   radiusMm?: number,
 *   lengthMm?: number,
 *   volumeM3?: number,
 *   taskId?: string,
 *   taskTitle?: string,
 *   previousRadiusMm?: number,
 *   previousLengthMm?: number,
 *   clearedCount?: number,
 * }} RoundwoodJournalEntry
 */

/**
 * @typedef {{ stock: RoundwoodStockItem[], journal: RoundwoodJournalEntry[] }} RoundwoodState
 */

const DEFAULT_STATE = /** @type {RoundwoodState} */ ({ stock: [], journal: [] })

const MAX_JOURNAL = 2000

/**
 * @returns {Promise<RoundwoodState>}
 */
export async function readRoundwood() {
  const raw = await readJson(ROUNDWOOD_FILE, DEFAULT_STATE)
  const stock = Array.isArray(raw.stock) ? raw.stock : []
  const journal = Array.isArray(raw.journal) ? raw.journal : []
  return { stock, journal }
}

/**
 * @param {RoundwoodState} state
 */
export async function writeRoundwood(state) {
  const journal =
    state.journal.length > MAX_JOURNAL
      ? state.journal.slice(state.journal.length - MAX_JOURNAL)
      : state.journal
  await writeJson(ROUNDWOOD_FILE, { stock: state.stock, journal })
}

/**
 * @param {number} id
 */
export function newNumericLogId(id) {
  const n = Math.round(Number(id))
  if (Number.isFinite(n) && n > 0) return n
  return Date.now()
}
