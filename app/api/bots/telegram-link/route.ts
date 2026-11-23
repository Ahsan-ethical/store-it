import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, issueSession } from "@/server/auth/auth";
import connectDB from "@/adapters/database/mongoose";
import User from "@/adapters/database/models/User";
import { verifyTelegramLoginPayload, type TelegramLoginPayload } from "@/server/auth/telegram";

export async function POST(req: NextRequest) {
  const auth = await getAuthUser({ allowUnlinked: true });
  if (!auth?.userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const payload = await req.json().catch(() => null) as TelegramLoginPayload | null;
  try {
    if (!payload) throw new Error("Missing Telegram auth data");
    verifyTelegramLoginPayload(payload);
    await connectDB();
    const telegramId = String(payload.id);
    const currentUser = await User.findById(auth.userId).select("telegramId").lean();
    if (currentUser?.telegramId && currentUser.telegramId !== telegramId) {
      return NextResponse.json({ error: "This StoreIt account already has a Telegram account linked" }, { status: 409 });
    }
    const claimed = await User.findOne({ telegramId, _id: { $ne: auth.userId } }).select("_id").lean();
    if (claimed) return NextResponse.json({ error: "That Telegram account is already linked to another StoreIt account" }, { status: 409 });
    const linkedUser = await User.findByIdAndUpdate(auth.userId, {
      $set: { telegramId, telegramUsername: payload.username || null },
    }, { new: true });
    if (!linkedUser) throw new Error("StoreIt account not found");
    const response = NextResponse.json({ linked: true });
    await issueSession(response, {
      userId: linkedUser._id.toString(),
      email: linkedUser.email,
      provider: linkedUser.provider || "credentials",
      storageused: linkedUser.storageused || 0,
      storagelimit: linkedUser.storagelimit || 5 * 1024 * 1024 * 1024,
      telegramLinked: true,
    });
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid Telegram auth";
    return NextResponse.json({ error: message }, { status: 401 });
  }
}
