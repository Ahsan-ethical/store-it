"use client";

import { useSyncExternalStore } from "react";

function subscribe() {
  return () => {};
}

function getSnapshot(): string {
  return new URLSearchParams(window.location.search).get("telegram_error") || "";
}

export function useTelegramOAuthError(): string {
  return useSyncExternalStore(subscribe, getSnapshot, () => "");
}
