# Telegram sign-in and one-bot-per-user setup

StoreIt uses Telegram's OpenID Connect login for both sign-in and account linking. After a user links Telegram, StoreIt creates or resumes one child-bot setup for that StoreIt account.

## 1. Configure Telegram in BotFather

1. Open the official `@BotFather` mini app and select `@storeit_storage_bot`.
2. Open **Login Widget**.
3. Register these Allowed URLs:
   - Website origin: `https://store-it-lovat-two.vercel.app`
   - Redirect URI: `https://store-it-lovat-two.vercel.app/api/auth/telegram/callback`
4. Copy the Client ID and Client Secret shown there. The Client ID should be the bot's ID (`8659935195`).
5. Keep the signing algorithm at **RS256** unless the server verifier is deliberately updated to support another algorithm.

## 2. Configure the StoreIt Vercel project

Add these environment variables to the **StoreIt** Vercel project for Production (and Preview if you test preview deployments):

```env
TELEGRAM_OIDC_CLIENT_ID=8659935195
TELEGRAM_OIDC_CLIENT_SECRET=<Client Secret from BotFather>
TELEGRAM_OIDC_REDIRECT_URI=https://store-it-lovat-two.vercel.app/api/auth/telegram/callback
```

Do not prefix the client secret with `NEXT_PUBLIC_`. Redeploy StoreIt after saving the variables.

## 3. Check the existing manager-bot/webhook settings

The same bot continues to manage child-bot creation. Keep `MANAGER_BOT_TOKEN` set to the token for `@storeit_storage_bot` in both the StoreIt and webhook Vercel projects. The manager bot webhook must still point to:

```text
https://webhook-chi-navy.vercel.app/api/tg/manager
```

The webhook domain receives bot updates; it is not the OIDC redirect URL.

## 4. User flow

1. A user signs in to StoreIt with Telegram, Google, or email/password. New email/password registrations are signed in immediately.
2. Any account without a linked Telegram identity is sent to `/connect-telegram`. The user must approve **Connect Telegram** before reaching StoreIt files or APIs.
3. Telegram sign-in satisfies the link requirement automatically. Users signing in with Google or email/password complete the separate OIDC link step.
4. StoreIt prepares one child-bot creation link for that account. The user creates the bot through Telegram.
5. The user opens the new bot and presses **Start**. The dashboard then shows it as active.

StoreIt reuses an existing active or pending bot setup. If the webhook marks a setup as an error, StoreIt will not silently create another bot for that account.
