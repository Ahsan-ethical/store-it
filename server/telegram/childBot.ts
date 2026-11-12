import crypto from "node:crypto";
import ChildBot from "@/adapters/database/models/ChildBot";

export type TelegramStorageCredentials = { token: string; chatId: string };

function encryptionKey(): Buffer {
  const value = process.env.TOKEN_ENCRYPTION_KEY || "";
  if (!/^[a-fA-F0-9]{64}$/.test(value)) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be 64 hexadecimal characters (32 bytes)");
  }
  return Buffer.from(value, "hex");
}

export function encryptChildBotToken(token: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

export function decryptChildBotToken(payload: string): string {
  const packed = Buffer.from(payload, "base64");
  if (packed.length < 29) throw new Error("Stored child bot token is invalid");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), packed.subarray(0, 12));
  decipher.setAuthTag(packed.subarray(12, 28));
  return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString("utf8");
}

export async function getActiveChildBot(ownerId: string) {
  return ChildBot.findOne({ owner: ownerId, status: "active", chatId: { $ne: null }, encryptedToken: { $ne: null } })
    .sort({ createdAt: -1 })
    .select("telegramBotId username chatId status")
    .lean();
}

export async function getTelegramCredentialsForBot(childBotId?: unknown): Promise<TelegramStorageCredentials | undefined> {
  if (!childBotId) return undefined; // Existing files keep using the legacy shared bot.
  const bot = await ChildBot.findById(childBotId).select("+encryptedToken chatId status").lean();
  if (!bot || bot.status !== "active" || !bot.chatId || !bot.encryptedToken) {
    throw new Error("The Telegram storage bot for this file is not active");
  }
  return { token: decryptChildBotToken(bot.encryptedToken), chatId: bot.chatId };
}

export function makeSuggestedBotUsername(): string {
  return `st${crypto.randomBytes(6).toString("hex")}bot`;
}
