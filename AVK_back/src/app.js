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

function normalizeOriginUrl(origin) {
  if (!origin || typeof origin !== 'string') return ''
  const t = origin.trim().replace(/\/$/, '')
  try {
    const u = new URL(t)
    return `${u.protocol}//${u.host}`.toLowerCase()
  } catch {
    return t.toLowerCase()
  }
}

/** Чи це деплой на Vercel (прод або preview *.vercel.app). */
function isVercelPreviewOrigin(origin) {
  try {
    const host = new URL(origin).hostname.toLowerCase()
    return host.endsWith('.vercel.app')
  } catch {
    return false
  }
}

function buildCorsOptions() {
  const configured = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => normalizeOriginUrl(s))
    .filter(Boolean)

  return {
    origin(origin, callback) {
      if (!origin) {
        callback(null, true)
        return
      }
      if (configured.length === 0) {
        callback(null, true)
        return
      }
      const normalized = normalizeOriginUrl(origin)
      if (configured.includes(normalized)) {
        callback(null, true)
        return
      }
      if (isVercelPreviewOrigin(origin)) {
        callback(null, true)
        return
      }
      callback(null, false)
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 204,
  }
}

export function createApp() {
  const app = express()
  app.set('trust proxy', 1)
  app.use(cors(buildCorsOptions()))
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
