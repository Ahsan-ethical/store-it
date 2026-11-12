import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/server/auth/auth";
import connectDB from "@/adapters/database/mongoose";
import User from "@/adapters/database/models/User";
import ChildBot from "@/adapters/database/models/ChildBot";
import { makeSuggestedBotUsername } from "@/server/telegram/childBot";

async function getManagerUsername(): Promise<string> {
  const token = process.env.MANAGER_BOT_TOKEN;
  if (!token) throw new Error("MANAGER_BOT_TOKEN is not configured");
  const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, { cache: "no-store" });
  const data = await response.json();
  if (!response.ok || !data.ok || typeof data.result?.username !== "string") {
    throw new Error("Could not read the manager bot username from Telegram");
  }
  return data.result.username;
}

export async function POST(_req: NextRequest) {
  const auth = await getAuthUser();
  if (!auth?.userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await connectDB();
  const user = await User.findById(auth.userId).select("telegramId telegramUsername").lean();
  if (!user?.telegramId) {
    return NextResponse.json({ error: "Link your Telegram account before creating its storage bot" }, { status: 409 });
  }

  const activeBot = await ChildBot.findOne({ owner: auth.userId, status: "active" }).sort({ createdAt: -1 });
  if (activeBot) return NextResponse.json({ status: activeBot.status, username: activeBot.username });

  let bot = await ChildBot.findOne({
    owner: auth.userId,
    status: { $in: ["pending_creation", "awaiting_start"] },
    expiresAt: { $gt: new Date() },
  }).sort({ createdAt: -1 });
  if (!bot) {
    bot = await ChildBot.create({
      owner: auth.userId,
      telegramOwnerId: user.telegramId,
      suggestedUsername: makeSuggestedBotUsername(),
      status: "pending_creation",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
  }

  if (bot.status === "awaiting_start") {
    return NextResponse.json({ status: bot.status, username: bot.username });
  }

  try {
    const managerUsername = await getManagerUsername();
    const name = encodeURIComponent(user.telegramUsername ? `${user.telegramUsername} Storage` : "StoreIt Storage");
    const createUrl = `https://t.me/newbot/${managerUsername}/${bot!.suggestedUsername}?name=${name}`;
    return NextResponse.json({ status: bot!.status, username: bot!.username, createUrl });
  } catch (error) {
    console.error("Child bot provisioning link error", error);
    return NextResponse.json({ error: "Could not prepare Telegram bot creation" }, { status: 503 });
  }
}
