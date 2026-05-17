import dns from 'node:dns'
import mongoose from 'mongoose'
import { MONGODB_DUAL_STACK, MONGODB_FORCE_IPV4, MONGODB_URI } from '../config/env.js'

let connectPromise = null

/** Atlas + Node (особливо 18+) на Windows часто ламаються через happy-eyeballs/IPv6 → TLS alert internal error. */
const useAtlasSocketWorkaround =
  !MONGODB_DUAL_STACK && (process.platform === 'win32' || MONGODB_FORCE_IPV4)

if (useAtlasSocketWorkaround) {
  try {
    dns.setDefaultResultOrder('ipv4first')
  } catch {
    // старий Node без цього API
  }
}

function normalizeMongoUri(raw) {
  const src = String(raw ?? '').trim()
  if (!src) return ''
  const marker = 'mongodb+srv://'
  const first = src.indexOf(marker)
  if (first < 0) return src
  const second = src.indexOf(marker, first + marker.length)
  if (second < 0) return src
  return src.slice(0, second)
}

export async function connectMongo() {
  if (mongoose.connection.readyState === 1) return mongoose.connection
  if (connectPromise) return connectPromise
  const uri = normalizeMongoUri(MONGODB_URI)
  if (!uri) {
    throw new Error('Не задано MONGODB_URI/COMPASS у .env для підключення до MongoDB')
  }
  connectPromise = mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10000,
    ...(useAtlasSocketWorkaround ? { family: 4, autoSelectFamily: false } : {}),
  })
  try {
    await connectPromise
    return mongoose.connection
  } finally {
    connectPromise = null
  }
}
