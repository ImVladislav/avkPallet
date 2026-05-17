/**
 * Точка входу для Render / production.
 * Динамічний import, щоб у лог потрапляли помилки завантаження модулів (імпорт `src/index.js`).
 */
import fs from 'node:fs'

console.log(`[avk-pallet] boot Node ${process.version} cwd=${process.cwd()}`)

process.on('uncaughtException', (err) => {
  try {
    fs.writeSync(2, `[avk-pallet] uncaughtException: ${err?.stack || err}\n`)
  } catch {
    // ignore
  }
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  try {
    const msg = reason instanceof Error ? reason.stack || reason.message : String(reason)
    fs.writeSync(2, `[avk-pallet] unhandledRejection: ${msg}\n`)
  } catch {
    // ignore
  }
  process.exit(1)
})

try {
  await import('./src/index.js')
  console.log('[avk-pallet] index.js finished init (process keeps running if HTTP server is up)')
} catch (err) {
  try {
    fs.writeSync(2, `[avk-pallet] FATAL import/start: ${err?.stack || err}\n`)
  } catch {
    console.error(err)
  }
  process.exit(1)
}
