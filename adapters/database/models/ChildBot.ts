import mongoose from "mongoose";

const ChildBotSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  // Telegram user id of the person who linked their Telegram account. The
  // manager webhook must compare this with managed_bot.user.id before it
  // accepts a newly-created bot for this StoreIt account.
  telegramOwnerId: { type: String, required: true, index: true },
  // Stable suggestion embedded in the Telegram creation link; the manager
  // webhook uses this to correlate Telegram's managed_bot update.
  suggestedUsername: { type: String, required: true, unique: true, index: true },
  telegramBotId: { type: String, unique: true, sparse: true, index: true },
  username: { type: String, default: null },
  // AES-256-GCM payload: base64(12-byte IV || 16-byte auth tag || ciphertext)
  encryptedToken: { type: String, default: null, select: false },
  status: {
    type: String,
    enum: ["pending_creation", "awaiting_start", "active", "revoked", "error"],
    default: "pending_creation",
    index: true,
  },
  chatId: { type: String, default: null },
  lastError: { type: String, default: null },
  expiresAt: { type: Date, required: true, index: true },
}, { timestamps: true, collection: "bots" });

ChildBotSchema.index({ owner: 1, status: 1, createdAt: -1 });

export default mongoose.models.ChildBot || mongoose.model("ChildBot", ChildBotSchema);
