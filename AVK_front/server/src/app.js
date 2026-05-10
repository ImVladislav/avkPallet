import path from 'path'
import { fileURLToPath } from 'url'
import express from 'express'
import cors from 'cors'
import apiRoutes from '../routes/index.js'

const __filename = fileURLToPath(import.meta.url)
const isRunDirectly =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(__filename)

if (isRunDirectly) {
  console.error(
    'Не запускайте app.js напряму — у ньому немає listen().\n' +
      'З папки server виконайте: npm start   або   node server.js',
  )
  process.exit(1)
}

export function createApp() {
  const app = express()
  app.use(cors({ origin: true, credentials: true }))
  app.use(express.json())

  app.get('/health', (_req, res) => {
    res.json({ ok: true })
  })

  app.use('/api', apiRoutes)

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' })
  })

  return app
}
