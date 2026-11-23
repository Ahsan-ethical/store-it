import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function TelegramTestPage() {
  return (
    <main className="mx-auto max-w-xl px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">Telegram sign-in check</h1>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">
        StoreIt now uses Telegram&apos;s OpenID Connect login for sign-in and account linking. Continue below to test the same flow used by the app. After approval, StoreIt will open your dashboard.
      </p>
      <div className="mt-6 flex flex-col items-start gap-3">
        <Button asChild><a href="/api/auth/telegram/start">Continue with Telegram</a></Button>
        <Button asChild variant="link"><Link href="/sign_in">Back to sign in</Link></Button>
      </div>
    </main>
  );
}
