"use client";

import { Button } from "./ui/button";
import { useTelegramOAuthError } from "./useTelegramOAuthError";

const ERROR_MESSAGES: Record<string, string> = {
  setup: "Telegram login is not configured yet. Add the Telegram OIDC settings in Vercel and try again.",
  denied: "Telegram login was cancelled. Try again or use another sign-in method.",
  state: "The Telegram login session expired or could not be verified. Start again.",
  session: "Your StoreIt session expired. Sign in again, then link Telegram from the dashboard.",
  linked: "This Telegram account is already linked to another StoreIt account. Sign in to the account it is linked to, or contact support.",
  failed: "Telegram could not complete sign-in. Check the BotFather allowed URLs and Vercel settings, then retry.",
};

export function TelegramLoginButton() {
  const errorCode = useTelegramOAuthError();
  const error = errorCode ? (ERROR_MESSAGES[errorCode] || ERROR_MESSAGES.failed) : "";

  return (
    <div className="flex w-full flex-col items-center gap-2">
      <Button asChild variant="secondary" className="w-full">
        <a href="/api/auth/telegram/start">Continue with Telegram</a>
      </Button>
      {error && <p role="alert" className="max-w-sm text-center text-sm text-destructive">{error}</p>}
    </div>
  );
}
