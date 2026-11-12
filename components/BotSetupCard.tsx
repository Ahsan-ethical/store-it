"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";

type BotState = {
  linked: boolean;
  telegramUsername: string | null;
  bot: { status: string; username: string | null; lastError: string | null; expired: boolean } | null;
};

type TelegramWidgetUser = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
};

declare global {
  interface Window { onStoreItTelegramLink?: (user: TelegramWidgetUser) => void }
}

export default function BotSetupCard() {
  const { isAuthenticated } = useAuth();
  const widgetRef = useRef<HTMLDivElement>(null);
  const provisionStarted = useRef(false);
  const [managerUsername, setManagerUsername] = useState("");
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
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  useEffect(() => {
    if (!isAuthenticated) return;
    void refresh().catch((err) => setError(err.message));
    fetch("/api/auth/telegram/bot-info", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => setManagerUsername(data.username || ""))
      .catch(() => {});
  }, [isAuthenticated, refresh]);

  useEffect(() => {
    if (state?.linked && state.bot?.status !== "active" && !createUrl && !provisionStarted.current) {
      provisionStarted.current = true;
      void prepareBot();
    }
  }, [state, createUrl, prepareBot]);

  useEffect(() => {
    if (!managerUsername || !state || state.linked || !widgetRef.current) return;
    const container = widgetRef.current;
    container.replaceChildren();
    window.onStoreItTelegramLink = async (user) => {
      setBusy(true);
      setError("");
      try {
        const res = await fetch("/api/bots/telegram-link", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: String(user.id),
            first_name: user.first_name || "",
            last_name: user.last_name || "",
            username: user.username || "",
            photo_url: user.photo_url || "",
            auth_date: String(user.auth_date),
            hash: user.hash,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Could not link Telegram account");
        provisionStarted.current = false;
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not link Telegram account");
      } finally {
        setBusy(false);
      }
    };
    const script = document.createElement("script");
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.async = true;
    script.setAttribute("data-telegram-login", managerUsername);
    script.setAttribute("data-size", "large");
    script.setAttribute("data-onauth", "onStoreItTelegramLink(user)");
    script.setAttribute("data-request-access", "write");
    container.appendChild(script);
    return () => {
      delete window.onStoreItTelegramLink;
      container.replaceChildren();
    };
  }, [managerUsername, state, refresh]);

  useEffect(() => {
    if (!isAuthenticated) return;
    const timer = setInterval(() => { void refresh().catch(() => {}); }, 5000);
    return () => clearInterval(timer);
  }, [isAuthenticated, refresh]);

  if (!isAuthenticated || !state) return null;

  return (
    <section className="mx-4 mt-4 rounded-xl border bg-card p-4 text-card-foreground shadow-sm md:mx-6" aria-live="polite">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Your Telegram storage bot</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Each StoreIt account uses its own bot for Telegram file storage.
          </p>
        </div>
        {state.bot?.status === "active" ? (
          <a className="rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent" href={`https://t.me/${state.bot.username}`} target="_blank" rel="noreferrer">
            Open @{state.bot.username}
          </a>
        ) : state.bot?.status === "awaiting_start" && state.bot.username ? (
          <a className="rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent" href={`https://t.me/${state.bot.username}`} target="_blank" rel="noreferrer">
            Open bot and press Start
          </a>
        ) : createUrl ? (
          <a className="rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent" href={createUrl} target="_blank" rel="noreferrer">
            Create your bot in Telegram
          </a>
        ) : state.linked ? (
          <button className="rounded-md border px-3 py-2 text-sm font-medium" onClick={() => { provisionStarted.current = false; void prepareBot(); }} disabled={busy}>
            {busy ? "Preparing…" : "Prepare bot link"}
          </button>
        ) : (
          <div ref={widgetRef} />
        )}
      </div>
      <p className="mt-3 text-sm text-muted-foreground">
        {state.bot?.status === "active" ? "Bot is ready. Telegram uploads are enabled." :
          state.bot?.status === "awaiting_start" ? "Open your new bot and press Start once to enable uploads." :
          state.bot?.status === "pending_creation" ? "Confirm creation in Telegram. This page will update automatically." :
          !state.linked ? "Link the Telegram account that will own your storage bot." :
          "Create your storage bot in Telegram. This page will update automatically."}
      </p>
      {busy && <p className="mt-2 text-xs text-muted-foreground">Working…</p>}
      {(error || state.bot?.lastError) && <p className="mt-2 text-sm text-destructive">{error || state.bot?.lastError}</p>}
    </section>
  );
}
