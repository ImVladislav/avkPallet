import { createApp } from './app.js'
import { PORT } from '../config/env.js'
import { ensureSeedUsers } from '../helpers/seedUsers.js'
import { connectMongo } from '../db/mongo.js'
import { migrateLegacyData } from '../db/migrateLegacyData.js'

async function main() {
  try {
    await connectMongo()
    await migrateLegacyData()
    await ensureSeedUsers()

    const app = createApp()
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`API listening on 0.0.0.0:${PORT}  (health: /health, api: /api)`)
      console.log('Сховище: MongoDB (users, tasks, roundwood_state)')
    })
  } catch (err) {
    console.error('FATAL: не вдалося запустити сервер')
    console.error(err)
    process.exit(1)
  }
}

await main()
