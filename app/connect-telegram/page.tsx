"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import RequireAuth from "@/components/RequireAuth";
import { useAuth } from "@/components/AuthProvider";
import { Button } from "@/components/ui/button";
import { useTelegramOAuthError } from "@/components/useTelegramOAuthError";

const TELEGRAM_ERRORS: Record<string, string> = {
  setup: "Telegram sign-in is not configured on the server yet. Please contact StoreIt support.",
  denied: "Telegram linking was cancelled. You can try again whenever you’re ready.",
  state: "The Telegram link session expired or could not be verified. Start again.",
  session: "Your StoreIt session expired. Sign in again, then link Telegram.",
  linked: "This Telegram account is linked to another StoreIt account, or this account already has a different Telegram account linked.",
  failed: "Telegram could not complete account linking. Please try again or contact StoreIt support.",
};

function TelegramConnectionStep() {
  const { user, logout } = useAuth();
  const router = useRouter();
  const telegramErrorCode = useTelegramOAuthError();
  const [signingOut, setSigningOut] = useState(false);

  async function switchAccount() {
    setSigningOut(true);
    await logout();
    router.replace("/sign_in");
  }

  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-xl items-center px-6 py-12">
      <section className="w-full rounded-xl border bg-card p-6 text-card-foreground shadow-sm sm:p-8" aria-labelledby="connect-telegram-title">
        <h1 id="connect-telegram-title" className="text-2xl font-semibold tracking-tight">Connect Telegram to continue</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          StoreIt gives each account its own Telegram storage bot. Connect the Telegram account that should own that bot before using your files.
        </p>
        {user?.email && <p className="mt-4 break-all text-sm">Signed in as <span className="font-medium">{user.email}</span></p>}

        {telegramErrorCode && (
          <p className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
            {TELEGRAM_ERRORS[telegramErrorCode] || TELEGRAM_ERRORS.failed}
          </p>
        )}

        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <Button asChild className="flex-1">
            <a href="/api/auth/telegram/start?mode=link">Connect Telegram</a>
          </Button>
          <Button type="button" variant="outline" onClick={() => void switchAccount()} disabled={signingOut}>
            {signingOut ? "Signing out…" : "Switch StoreIt account"}
          </Button>
        </div>

        <p className="mt-4 text-xs leading-5 text-muted-foreground">
          Telegram is used to verify who owns your personal storage bot. StoreIt won&apos;t create the bot until you approve the connection.
        </p>
      </section>
    </main>
  );
}

export default function ConnectTelegramPage() {
  return (
    <RequireAuth allowUnlinked>
      <TelegramConnectionStep />
    </RequireAuth>
  );
}
