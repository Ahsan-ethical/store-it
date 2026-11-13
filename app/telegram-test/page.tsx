"use client";

import { useEffect, useRef, useState } from "react";

type TelegramUser = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
};

declare global {
  interface Window {
    onTelegramAuth?: (user: TelegramUser) => void;
  }
}

export default function TelegramTestPage() {
  const widgetHost = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("Waiting for Telegram login…");
  const [profile, setProfile] = useState<Omit<TelegramUser, "hash"> | null>(null);

  useEffect(() => {
    // Telegram calls this global function after a successful widget login.
    window.onTelegramAuth = async (user: TelegramUser) => {
      setStatus("Telegram returned login data. Verifying the signature on the server…");

      try {
        const response = await fetch("/api/telegram/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(user),
        });
        const result = await response.json();

        if (!response.ok) {
          setStatus(`Verification failed: ${result.error ?? "Unknown error"}`);
          return;
        }

        setProfile(result.user);
        setStatus("Success: Telegram login signature verified.");
      } catch {
        setStatus("Could not reach the verification endpoint. Check the Vercel deployment logs.");
      }
    };

    const host = widgetHost.current;
    if (!host) return;

    host.innerHTML = "";
    const script = document.createElement("script");
    script.async = true;
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.setAttribute("data-telegram-login", process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME ?? "storeitstorage");
    script.setAttribute("data-size", "large");
    script.setAttribute("data-userpic", "false");
    script.setAttribute("data-onauth", "onTelegramAuth(user)");
    host.appendChild(script);

    return () => {
      delete window.onTelegramAuth;
      host.innerHTML = "";
    };
  }, []);

  return (
    <main style={{ maxWidth: 680, margin: "64px auto", padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1>Telegram login diagnostic</h1>
      <p>
        This page tests Telegram&apos;s classic Login Widget independently of StoreIt&apos;s
        existing sign-in code. It does not change your bot settings.
      </p>

      <section style={{ border: "1px solid #ddd", borderRadius: 12, padding: 24, marginTop: 24 }}>
        <h2 style={{ marginTop: 0 }}>1. Sign in with Telegram</h2>
        <div ref={widgetHost} />
        <p role="status" aria-live="polite">{status}</p>
      </section>

      {profile && (
        <section style={{ border: "1px solid #16a34a", borderRadius: 12, padding: 24, marginTop: 20 }}>
          <h2 style={{ marginTop: 0 }}>2. Verified Telegram profile</h2>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {JSON.stringify(profile, null, 2)}
          </pre>
        </section>
      )}

      <p style={{ color: "#666", fontSize: 13, marginTop: 28 }}>
        Safety: the bot token stays on the server. This page only displays profile fields
        returned by Telegram after the server verifies Telegram&apos;s signature.
      </p>
    </main>
  );
}
