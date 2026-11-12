# Child bot integration contract

StoreIt and the separate manager webhook use the same MongoDB database. The
`ChildBot` Mongoose model explicitly uses the `bots` collection so both apps
can read and update the same records.

## Bot record

StoreIt creates this record when a signed-in user starts setup:

```text
owner             MongoDB ObjectId of the StoreIt user
telegramOwnerId   Telegram user ID linked to that StoreIt account
suggestedUsername random bot username from the newbot link
telegramBotId     Telegram bot's numeric ID, as a string (set by webhook)
username          Telegram bot username (set by webhook)
encryptedToken    base64(12-byte IV || 16-byte GCM tag || ciphertext)
status            pending_creation | awaiting_start | active | revoked | error
chatId            Telegram private chat ID (set after the owner presses Start)
expiresAt         pending setup expiry
```

Use `owner` to locate the StoreIt user's current bot. Keep older `bots` records
when a user must create a replacement: `File.telegramBot` and
`TelegramChunk.telegramBot` point at the exact record needed to read each file.

## Manager webhook behavior

1. On `update.managed_bot`, find a `bots` record by the suggested username and
   `status: "pending_creation"`. If the creator changed the suggested username,
   match the one unexpired pending record by Telegram owner ID instead.
2. Verify `String(update.managed_bot.user.id) === telegramOwnerId`. Reject and
   do not store a token if the creator does not match the linked Telegram user.
3. Call `getManagedBotToken` using the managed bot's Telegram user ID. Encrypt
   the returned token with AES-256-GCM and the shared `TOKEN_ENCRYPTION_KEY`.
   Store the packed value in `encryptedToken`, then set `telegramBotId`,
   `username`, and `status: "awaiting_start"`.
4. Call `setWebhook` for the webhook project's child route, using this bot
   record's Mongo `_id` in the route, `allowed_updates: ["message"]`, and the
   webhook project's `TELEGRAM_WEBHOOK_SECRET` as `secret_token`.
5. On a child-bot `/start`, load the record by the route's Mongo `_id`, verify
   `String(message.from.id) === telegramOwnerId`, then store
   `String(message.chat.id)` in `chatId` and set `status: "active"`.

The encryption format must match `encryptChildBotToken` and
`decryptChildBotToken` in `server/telegram/childBot.ts`. Never store a child
token as plaintext. The manager webhook and StoreIt must keep the same
`TOKEN_ENCRYPTION_KEY`; the webhook secret remains a separate value.
