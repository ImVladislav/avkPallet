export const ROUNDWOOD_CHANGED_EVENT = 'avk-roundwood-changed'
export const ROUNDWOOD_BUMP_KEY = 'avk-roundwood-bump'

export function notifyRoundwoodChanged(): void {
  window.dispatchEvent(new Event(ROUNDWOOD_CHANGED_EVENT))
  try {
    localStorage.setItem(ROUNDWOOD_BUMP_KEY, String(Date.now()))
  } catch {
    /* ignore */
  }
}
