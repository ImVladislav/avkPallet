import mongoose from 'mongoose'

const roundwoodStateSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    stock: { type: [mongoose.Schema.Types.Mixed], default: [] },
    brusStock: { type: [mongoose.Schema.Types.Mixed], default: [] },
    journal: { type: [mongoose.Schema.Types.Mixed], default: [] },
  },
  {
    versionKey: false,
    strict: true,
    collection: 'roundwood_state',
  },
)

export const RoundwoodStateModel =
  mongoose.models.RoundwoodStateModel ||
  mongoose.model('RoundwoodStateModel', roundwoodStateSchema)
