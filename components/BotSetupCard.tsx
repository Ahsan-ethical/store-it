"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { Button } from "@/components/ui/button";
import { useTelegramOAuthError } from "@/components/useTelegramOAuthError";

type BotState = {
  linked: boolean;
  telegramUsername: string | null;
  bot: { status: string; username: string | null; suggestedUsername?: string; lastError: string | null; expired: boolean } | null;
};

const TELEGRAM_ERRORS: Record<string, string> = {
  setup: "Telegram login is not configured yet. Add the Telegram OIDC settings in Vercel.",
  denied: "Telegram linking was cancelled. You can try again whenever you’re ready.",
  state: "The Telegram link session expired or could not be verified. Start again.",
  session: "Your StoreIt session expired. Sign in again, then link Telegram from the dashboard.",
  linked: "This Telegram account is linked to another StoreIt account, or this account already has a different Telegram account linked.",
  failed: "Telegram could not complete account linking. Check the BotFather allowed URLs and Vercel settings, then retry.",
};

export default function BotSetupCard() {
  const { isAuthenticated } = useAuth();
  const telegramErrorCode = useTelegramOAuthError();
  const provisionStarted = useRef(false);
  const [state, setState] = useState<BotState | null>(null);
  const [createUrl, setCreateUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/bots/status", { cache: "no-store" });
    if (!res.ok) throw new Error("Could not load your Telegram bot status");
    setState(await res.json());
  }, []);

  const prepareBot = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/bots/provision", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not prepare your storage bot");
      setCreateUrl(data.createUrl || "");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not prepare your storage bot");
      provisionStarted.current = false;
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  useEffect(() => {
    if (!isAuthenticated) return;
    void refresh().catch((err) => setError(err.message));
  }, [isAuthenticated, refresh]);

  useEffect(() => {
    if (state?.linked && state.bot?.status !== "active" && state.bot?.status !== "error" && !createUrl && !provisionStarted.current) {
      provisionStarted.current = true;
      void prepareBot();
    }
  }, [state, createUrl, prepareBot]);

  useEffect(() => {
    if (!isAuthenticated) return;
    const timer = setInterval(() => { void refresh().catch(() => {}); }, 5000);
    return () => clearInterval(timer);
  }, [isAuthenticated, refresh]);

  const visibleError = telegramErrorCode
    ? (TELEGRAM_ERRORS[telegramErrorCode] || TELEGRAM_ERRORS.failed)
    : error;

  if (!isAuthenticated) return null;

  if (!state) {
    return (
      <section className="mx-4 mt-4 rounded-xl border bg-card p-4 text-card-foreground shadow-sm md:mx-6" aria-live="polite">
        <h2 className="font-semibold">Your Telegram storage bot</h2>
        <p className="mt-1 text-sm text-muted-foreground">{visibleError || "Loading your Telegram bot setup…"}</p>
        {visibleError && <Button className="mt-3" variant="outline" onClick={() => { setError(""); void refresh().catch((err) => setError(err.message)); }}>Retry</Button>}
      </section>
    );
  }

  const statusText = state.bot?.status === "active"
    ? "Your personal storage bot is ready. Telegram uploads are enabled."
    : state.bot?.status === "awaiting_start"
      ? "Open your new bot and press Start once to enable uploads."
      : state.bot?.status === "pending_creation"
        ? "Finish creating your bot in Telegram. This page updates automatically."
        : state.bot?.status === "error"
          ? state.bot.lastError || "Telegram could not finish setting up this bot. Contact StoreIt support before creating another."
          : !state.linked
            ? "Link the Telegram account that will own your storage bot."
            : "Your Telegram account is linked. Prepare your personal storage bot.";

  return (
    <section className="mx-4 mt-4 rounded-xl border bg-card p-4 text-card-foreground shadow-sm md:mx-6" aria-live="polite">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">Your Telegram storage bot</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            StoreIt creates one storage bot for each account. Link Telegram, create the bot, then press Start to activate it.
          </p>
        </div>

        {state.bot?.status === "active" && state.bot.username ? (
          <Button asChild variant="outline"><a href={`https://t.me/${state.bot.username}`} target="_blank" rel="noreferrer">Open @{state.bot.username}</a></Button>
        ) : state.bot?.status === "awaiting_start" && state.bot.username ? (
          <Button asChild variant="outline"><a href={`https://t.me/${state.bot.username}`} target="_blank" rel="noreferrer">Open bot and press Start</a></Button>
        ) : state.bot?.status === "error" ? (
          <span className="text-sm font-medium text-destructive">Setup needs attention</span>
        ) : createUrl ? (
          <Button asChild variant="outline"><a href={createUrl} target="_blank" rel="noreferrer">Create your bot in Telegram</a></Button>
        ) : state.linked ? (
          <Button variant="outline" onClick={() => { provisionStarted.current = false; void prepareBot(); }} disabled={busy}>
            {busy ? "Preparing…" : "Prepare bot link"}
          </Button>
        ) : (
          <Button asChild variant="outline"><a href="/api/auth/telegram/start?mode=link">Link Telegram account</a></Button>
        )}
      </div>

      <p className="mt-3 text-sm text-muted-foreground">{statusText}</p>
      {state.bot?.status === "pending_creation" && createUrl && (
        <p className="mt-2 text-sm">
          <a className="font-medium underline underline-offset-4" href={createUrl} target="_blank" rel="noreferrer">Continue bot creation in Telegram</a>
        </p>
      )}
      {busy && <p className="mt-2 text-xs text-muted-foreground">Preparing your bot setup…</p>}
      {visibleError && <p role="alert" className="mt-2 text-sm text-destructive">{visibleError}</p>}
    </section>
  );
}
