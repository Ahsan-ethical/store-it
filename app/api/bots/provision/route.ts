import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { getAuthUser } from "@/server/auth/auth";
import connectDB from "@/adapters/database/mongoose";
import User from "@/adapters/database/models/User";
import ChildBot from "@/adapters/database/models/ChildBot";
import { makeSuggestedBotUsername } from "@/server/telegram/childBot";

async function getManagerUsername(): Promise<string> {
  const token = process.env.MANAGER_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("MANAGER_BOT_TOKEN is not configured");
  const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const data = await response.json();
  if (!response.ok || !data.ok || typeof data.result?.username !== "string") {
    throw new Error("Could not read the manager bot username from Telegram");
  }
  return data.result.username;
}

export async function POST() {
  const auth = await getAuthUser();
  if (!auth?.userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await connectDB();
  const user = await User.findById(auth.userId).select("telegramId telegramUsername").lean();
  if (!user) return NextResponse.json({ error: "StoreIt account not found" }, { status: 404 });
  if (!user.telegramId) {
    return NextResponse.json({ error: "Link your Telegram account before creating its storage bot" }, { status: 409 });
  }

  // Serialize provisioning per StoreIt account. A double click, tab retry, or
  // overlapping dashboard poll must reuse one pending bot request.
  const now = new Date();
  const lockId = crypto.randomUUID();
  const lockUntil = new Date(now.getTime() + 60_000);
  const lockedUser = await User.findOneAndUpdate(
    {
      _id: auth.userId,
      $or: [
        { botProvisionLockUntil: null },
        { botProvisionLockUntil: { $exists: false } },
        { botProvisionLockUntil: { $lte: now } },
      ],
    },
    { $set: { botProvisionLockId: lockId, botProvisionLockUntil: lockUntil } },
    { new: true },
  ).select("telegramId telegramUsername").lean();

  if (!lockedUser) {
    const activeBot = await ChildBot.findOne({ owner: auth.userId, status: "active" }).sort({ createdAt: -1 }).lean();
    if (activeBot) return NextResponse.json({ status: activeBot.status, username: activeBot.username });
    return NextResponse.json({ error: "Bot setup is already running. Wait a moment and retry." }, { status: 409 });
  }

  try {
    const activeBot = await ChildBot.findOne({ owner: auth.userId, status: "active" }).sort({ createdAt: -1 }).lean();
    if (activeBot) return NextResponse.json({ status: activeBot.status, username: activeBot.username });

    // An error may mean Telegram already created the bot but webhook setup did
    // not finish. Never create another bot automatically in that state.
    const failedBot = await ChildBot.findOne({ owner: auth.userId, status: "error" }).sort({ createdAt: -1 }).lean();
    if (failedBot) {
      return NextResponse.json({
        status: "error",
        error: failedBot.lastError || "The existing bot needs support before another bot can be created.",
      }, { status: 409 });
    }

    let bot = await ChildBot.findOne({
      owner: auth.userId,
      status: { $in: ["pending_creation", "awaiting_start"] },
    }).sort({ createdAt: -1 });

    if (bot?.status === "awaiting_start") {
      return NextResponse.json({ status: bot.status, username: bot.username });
    }

    if (!bot) {
      bot = await ChildBot.create({
        owner: auth.userId,
        telegramOwnerId: lockedUser.telegramId,
        suggestedUsername: makeSuggestedBotUsername(),
        status: "pending_creation",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
    } else if (bot.expiresAt <= new Date()) {
      // Reopen the same pending request instead of allocating a second child bot.
      bot.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await bot.save();
    }

    const managerUsername = await getManagerUsername();
    const displayName = lockedUser.telegramUsername ? `${lockedUser.telegramUsername} Storage` : "StoreIt Storage";
    const createUrl = `https://t.me/newbot/${managerUsername}/${bot.suggestedUsername}?name=${encodeURIComponent(displayName)}`;
    return NextResponse.json({ status: bot.status, username: bot.username, createUrl });
  } catch (error) {
    console.error("Child bot provisioning link error", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "Could not prepare your storage bot. Retry in a moment." }, { status: 503 });
  } finally {
    await User.updateOne(
      { _id: auth.userId, botProvisionLockId: lockId },
      { $unset: { botProvisionLockId: 1, botProvisionLockUntil: 1 } },
    );
  }
}
