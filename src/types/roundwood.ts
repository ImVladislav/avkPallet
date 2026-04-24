/** Колода на складі кругляка (мм у полях radius / length). */
export type LogItem = {
  id: number
  radius: number
  length: number
  createdAt: string
  /** Об'єм з бірки (м³), якщо прийом за біркою. */
  volumeM3?: number
}

export type RoundwoodJournalKind =
  | 'received'
  | 'receive_cancelled'
  | 'band_consumed'
  | 'stock_updated'
  | 'stock_cleared'

export type RoundwoodJournalEntry = {
  id: string
  kind: RoundwoodJournalKind
  at: string
  recordedBy: { username: string; sub?: string }
  logId?: number
  radiusMm?: number
  lengthMm?: number
  volumeM3?: number
  taskId?: string
  taskTitle?: string
  previousRadiusMm?: number
  previousLengthMm?: number
  clearedCount?: number
}
