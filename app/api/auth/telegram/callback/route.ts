import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, issueSession } from "@/server/auth/auth";
import {
  exchangeTelegramCode,
  linkTelegramToUser,
  safeEqual,
  signInWithTelegram,
  verifyTelegramIdToken,
} from "@/server/auth/telegramOidc";

const COOKIE_PATH = "/api/auth/telegram";
const COOKIE_NAMES = [
  "telegram_oauth_state",
  "telegram_oauth_nonce",
  "telegram_oauth_verifier",
  "telegram_oauth_mode",
] as const;

function finishRedirect(request: NextRequest, mode: "login" | "link", error?: string) {
  const destination = mode === "link" ? "/dashboard" : error ? "/sign_in" : "/dashboard";
  const url = new URL(destination, request.url);
  if (error) url.searchParams.set("telegram_error", error);
  const response = NextResponse.redirect(url);
  for (const name of COOKIE_NAMES) {
    response.cookies.set(name, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: COOKIE_PATH, maxAge: 0 });
  }
  return response;
}

export async function GET(request: NextRequest) {
  const mode = request.cookies.get("telegram_oauth_mode")?.value === "link" ? "link" : "login";
  const providerError = request.nextUrl.searchParams.get("error");
  if (providerError) return finishRedirect(request, mode, "denied");

  const state = request.nextUrl.searchParams.get("state");
  const cookieState = request.cookies.get("telegram_oauth_state")?.value;
  const nonce = request.cookies.get("telegram_oauth_nonce")?.value;
  const verifier = request.cookies.get("telegram_oauth_verifier")?.value;
  const code = request.nextUrl.searchParams.get("code");
  if (!state || !cookieState || !safeEqual(state, cookieState) || !nonce || !verifier || !code) {
    return finishRedirect(request, mode, "state");
  }

  try {
    const currentAuth = mode === "link" ? await getAuthUser({ allowUnlinked: true }) : null;
    if (mode === "link" && !currentAuth?.userId) {
      return finishRedirect(request, mode, "session");
    }

    const idToken = await exchangeTelegramCode(code, verifier);
    const claims = await verifyTelegramIdToken(idToken, nonce);

    if (mode === "link") {
      const user = await linkTelegramToUser(currentAuth!.userId, claims);
      const response = finishRedirect(request, mode);
      await issueSession(response, user);
      return response;
    }

    const user = await signInWithTelegram(claims);
    const response = finishRedirect(request, mode);
    await issueSession(response, user);
    return response;
  } catch (error) {
    console.error("Telegram login callback failed", error instanceof Error ? error.message : "unknown error");
    const message = error instanceof Error ? error.message : "";
    if (mode === "link" && message.includes("already linked")) {
      return finishRedirect(request, mode, "linked");
    }
    return finishRedirect(request, mode, "failed");
  }
}
