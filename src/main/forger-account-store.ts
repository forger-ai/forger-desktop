import fs from 'node:fs/promises';
import path from 'node:path';
import type { ForgerAccountSession, SubscriptionTier } from '../shared/types';

export type StoredForgerAccount = ForgerAccountSession & { token?: string };

export const normalizeForgerAccountUser = (value: unknown): ForgerAccountSession['user'] => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'number' ? record.id : Number(record.id);
  const email = typeof record.email === 'string' ? record.email : '';
  if (!Number.isFinite(id) || !email) {
    return undefined;
  }

  return {
    id,
    email,
    firstName: typeof record.first_name === 'string' ? record.first_name : typeof record.firstName === 'string' ? record.firstName : undefined,
    lastName: typeof record.last_name === 'string' ? record.last_name : typeof record.lastName === 'string' ? record.lastName : undefined,
    confirmed: Boolean(record.confirmed),
    subscriptionTier: normalizeSubscriptionTier(record.subscription_tier ?? record.subscriptionTier),
  };
};

const normalizeSubscriptionTier = (value: unknown): SubscriptionTier => {
  return value === 'demo' || value === 'pro' ? value : 'free';
};

export const publicForgerAccount = (account: StoredForgerAccount): ForgerAccountSession => ({
  authenticated: Boolean(account.authenticated && account.token),
  confirmationRequired: account.confirmationRequired,
  user: account.user,
});

export class ForgerAccountStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<StoredForgerAccount> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as StoredForgerAccount;
      const user = normalizeForgerAccountUser(parsed.user);
      return {
        authenticated: Boolean(parsed.authenticated && parsed.token && user),
        confirmationRequired: Boolean(parsed.confirmationRequired),
        token: typeof parsed.token === 'string' ? parsed.token : undefined,
        user,
      };
    } catch {
      return { authenticated: false };
    }
  }

  async save(account: StoredForgerAccount): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(account, null, 2), 'utf8');
  }

  async clear(): Promise<void> {
    await fs.rm(this.filePath, { force: true }).catch(() => undefined);
  }
}
