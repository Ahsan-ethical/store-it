import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/server/auth/auth";
import {
  createCodeChallenge,
  createTelegramAuthorization,
  randomSecret,
} from "@/server/auth/telegramOidc";

const COOKIE_PATH = "/api/auth/telegram";
const COOKIE_MAX_AGE = 10 * 60;

export async function GET(request: NextRequest) {
  const mode = request.nextUrl.searchParams.get("mode") === "link" ? "link" : "login";
  const destination = mode === "link" ? "/dashboard" : "/sign_in";

  if (mode === "link" && !(await getAuthUser({ allowUnlinked: true }))) {
    return NextResponse.redirect(new URL("/sign_in", request.url));
  }

  try {
    const state = randomSecret();
    const nonce = randomSecret();
    const verifier = randomSecret();
    const response = NextResponse.redirect(createTelegramAuthorization({
      state,
      nonce,
      codeChallenge: createCodeChallenge(verifier),
    }));
    const secure = process.env.NODE_ENV === "production";

    response.cookies.set("telegram_oauth_state", state, {
      httpOnly: true, secure, sameSite: "lax", path: COOKIE_PATH, maxAge: COOKIE_MAX_AGE,
    });
    response.cookies.set("telegram_oauth_nonce", nonce, {
      httpOnly: true, secure, sameSite: "lax", path: COOKIE_PATH, maxAge: COOKIE_MAX_AGE,
    });
    response.cookies.set("telegram_oauth_verifier", verifier, {
      httpOnly: true, secure, sameSite: "lax", path: COOKIE_PATH, maxAge: COOKIE_MAX_AGE,
    });
    response.cookies.set("telegram_oauth_mode", mode, {
      httpOnly: true, secure, sameSite: "lax", path: COOKIE_PATH, maxAge: COOKIE_MAX_AGE,
    });
    return response;
  } catch (error) {
    console.error("Telegram login setup error", error instanceof Error ? error.message : "unknown error");
    const url = new URL(destination, request.url);
    url.searchParams.set("telegram_error", "setup");
    return NextResponse.redirect(url);
  }
}
