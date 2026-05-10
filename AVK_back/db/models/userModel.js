import mongoose from 'mongoose'

const userSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    username: { type: String, required: true, unique: true, index: true },
    passwordHash: { type: String, required: true },
    role: { type: String, required: true },
    displayName: { type: String, required: true },
    tabs: { type: [String], default: undefined },
  },
  {
    versionKey: false,
    strict: true,
    collection: 'users',
  },
)

export const UserModel = mongoose.models.UserModel || mongoose.model('UserModel', userSchema)
