import * as SecureStore from 'expo-secure-store';

export type TokenPair = {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
};

export interface SessionStore {
  read(): Promise<TokenPair | null>;
  write(tokens: TokenPair): Promise<void>;
  clear(): Promise<void>;
}

const SESSION_KEY = 'benzene.native.session.v1';

function isTokenPair(value: unknown): value is TokenPair {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<TokenPair>;
  return typeof candidate.accessToken === 'string' && candidate.accessToken.length > 0
    && typeof candidate.refreshToken === 'string' && candidate.refreshToken.length > 0
    && typeof candidate.accessTokenExpiresAt === 'number'
    && Number.isFinite(candidate.accessTokenExpiresAt);
}

export const secureSessionStore: SessionStore = {
  async read() {
    const raw = await SecureStore.getItemAsync(SESSION_KEY);
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isTokenPair(parsed)) return parsed;
    } catch {
      // A damaged local session is discarded instead of being used as a credential.
    }
    await SecureStore.deleteItemAsync(SESSION_KEY);
    return null;
  },
  async write(tokens) {
    if (!isTokenPair(tokens)) throw new Error('The server returned an invalid native session.');
    await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(tokens), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  },
  clear() {
    return SecureStore.deleteItemAsync(SESSION_KEY);
  },
};

export function isTokenPairValue(value: unknown): value is TokenPair {
  return isTokenPair(value);
}
