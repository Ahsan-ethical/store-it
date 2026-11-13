import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;

  if (!botToken) {
    return NextResponse.json(
      { error: "Server configuration missing: TELEGRAM_BOT_TOKEN." },
      { status: 500 }
    );
  }

  let data: Record<string, unknown>;
  try {
    data = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (
    typeof data.hash !== "string" ||
    typeof data.id !== "number" ||
    typeof data.auth_date !== "number"
  ) {
    return NextResponse.json({ error: "Telegram login data is incomplete." }, { status: 400 });
  }

  // Telegram Login Widget signature verification:
  // secret_key = SHA256(bot_token)
  // HMAC_SHA256(data_check_string, secret_key)
  const receivedHash = data.hash;
  const fields = Object.entries(data)
    .filter(([key, value]) => key !== "hash" && value !== undefined && value !== null)
    .map(([key, value]) => [key, String(value)] as const)
    .sort(([a], [b]) => a.localeCompare(b));

  const dataCheckString = fields.map(([key, value]) => `${key}=${value}`).join("\n");
  const secretKey = createHash("sha256").update(botToken).digest();
  const calculatedHash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  const received = Buffer.from(receivedHash, "hex");
  const calculated = Buffer.from(calculatedHash, "hex");

  if (
    received.length !== calculated.length ||
    !timingSafeEqual(received, calculated)
  ) {
    return NextResponse.json({ error: "Telegram signature is invalid." }, { status: 401 });
  }

  // Reject old login payloads to reduce replay risk.
  const ageSeconds = Math.floor(Date.now() / 1000) - data.auth_date;
  if (ageSeconds < -30 || ageSeconds > 5 * 60) {
    return NextResponse.json({ error: "Telegram login data expired. Please try again." }, { status: 401 });
  }

  const user = {
    id: data.id,
    first_name: typeof data.first_name === "string" ? data.first_name : "",
    ...(typeof data.last_name === "string" ? { last_name: data.last_name } : {}),
    ...(typeof data.username === "string" ? { username: data.username } : {}),
    ...(typeof data.photo_url === "string" ? { photo_url: data.photo_url } : {}),
    auth_date: data.auth_date,
  };

  return NextResponse.json({ ok: true, user });
}
