import { NextResponse } from "next/server";
import { getAuthUser } from "@/server/auth/auth";
import connectDB from "@/adapters/database/mongoose";
import User from "@/adapters/database/models/User";
import ChildBot from "@/adapters/database/models/ChildBot";

export async function GET() {
  const auth = await getAuthUser({ allowUnlinked: true });
  if (!auth?.userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await connectDB();
  const user = await User.findById(auth.userId).select("provider providerId telegramId telegramUsername").lean();
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  // Existing Telegram-login accounts already proved their Telegram identity.
  if (!user.telegramId && user.provider === "telegram" && user.providerId) {
    await User.updateOne({ _id: auth.userId, telegramId: null }, { $set: { telegramId: user.providerId } });
    user.telegramId = user.providerId;
  }

  const bot = await ChildBot.findOne({ owner: auth.userId, status: "active" })
    .sort({ createdAt: -1 })
    .select("status username suggestedUsername lastError expiresAt")
    .lean() || await ChildBot.findOne({ owner: auth.userId, status: { $in: ["pending_creation", "awaiting_start", "error"] } })
    .sort({ createdAt: -1 })
    .select("status username suggestedUsername lastError expiresAt")
    .lean();
  return NextResponse.json({
    linked: Boolean(user.telegramId),
    telegramUsername: user.telegramUsername || null,
    bot: bot ? {
      status: bot.status,
      username: bot.username,
      suggestedUsername: bot.suggestedUsername,
      lastError: bot.lastError,
      expired: bot.expiresAt < new Date(),
    } : null,
  });
}
