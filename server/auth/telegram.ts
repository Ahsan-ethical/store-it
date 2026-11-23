import crypto from 'crypto';
import connectDB from '@/adapters/database/mongoose';
import User from '@/adapters/database/models/User';
import type { AuthUser } from './token';

// The widget domain is configured for the manager bot. Keep the legacy bot
// fallback for deployments that haven't moved their login widget yet.
const TELEGRAM_BOT_TOKEN = process.env.MANAGER_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';

export type TelegramLoginPayload = {
  id?: string;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date?: string;
  hash?: string;
};

export function verifyTelegramLoginPayload(payload: TelegramLoginPayload): void {
  if (!payload?.id || !payload?.hash) {
    throw new Error('Missing Telegram auth data');
  }

  const secret = crypto.createHash('sha256').update(TELEGRAM_BOT_TOKEN).digest();

  const dataCheckString = Object.entries({
    auth_date: payload.auth_date,
    first_name: payload.first_name,
    id: payload.id,
    last_name: payload.last_name,
    photo_url: payload.photo_url,
    username: payload.username,
  })
    .filter(([, v]) => v !== undefined && v !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const computedHash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

  if (computedHash !== payload.hash) {
    throw new Error('Invalid Telegram auth');
  }

  const authDate = parseInt(payload.auth_date || '0', 10);
  if (!Number.isFinite(authDate) || authDate <= 0 || Date.now() / 1000 - authDate > 86400 || authDate > Date.now() / 1000 + 60) {
    throw new Error('Telegram auth expired');
  }
}

export async function verifyTelegramLogin(payload: TelegramLoginPayload): Promise<AuthUser> {
  verifyTelegramLoginPayload(payload);

  try {
    await connectDB();
  } catch {
    throw new Error('Database error');
  }

  const telegramId = payload.id;
  let user = await User.findOne({ telegramId }) || await User.findOne({ provider: 'telegram', providerId: telegramId });

  if (user) {
    user.telegramId = telegramId;
    user.telegramUsername = payload.username || null;
    if (user.provider === 'telegram') user.providerId = telegramId;
    await user.save();
  }

  if (!user) {
    user = await User.create({
      email: `telegram_${telegramId}@telegram.storeit`,
      name: payload.first_name + (payload.last_name ? ` ${payload.last_name}` : ''),
      provider: 'telegram',
      providerId: telegramId,
      telegramId,
      telegramUsername: payload.username || null,
    });
  }

  return {
    userId: user._id.toString(),
    email: user.email,
    provider: user.provider || 'telegram',
    storageused: user.storageused || 0,
    storagelimit: user.storagelimit || 5 * 1024 * 1024 * 1024,
    telegramLinked: Boolean(user.telegramId || user.providerId),
  };
}
