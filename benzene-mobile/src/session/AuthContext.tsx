import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { secureSessionStore, type TokenPair } from './sessionStore';
import { clearRefreshCache, requestJson } from '../api/client';

type AuthState = {
  ready: boolean;
  tokens: TokenPair | null;
  startSession(tokens: TokenPair): Promise<void>;
  endSession(): Promise<void>;
  request<T>(path: string): Promise<T>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [tokens, setTokens] = useState<TokenPair | null>(null);
  const sessionEpoch = useRef(0);

  useEffect(() => {
    let alive = true;
    secureSessionStore.read()
      .then((stored) => {
        if (alive) setTokens(stored);
      })
      .catch(() => {
        if (alive) setTokens(null);
      })
      .finally(() => {
        if (alive) setReady(true);
      });
    return () => { alive = false; };
  }, []);

  const value = useMemo<AuthState>(() => ({
    ready,
    tokens,
    async startSession(nextTokens) {
      sessionEpoch.current += 1;
      await secureSessionStore.write(nextTokens);
      setTokens(nextTokens);
    },
    async endSession() {
      sessionEpoch.current += 1;
      setTokens(null);
      clearRefreshCache();
      await secureSessionStore.clear();
    },
    async request<T>(path: string) {
      if (!tokens) throw new Error('Sign in to continue.');
      const requestEpoch = sessionEpoch.current;
      return requestJson<T>(path, tokens, async (updated) => {
        if (sessionEpoch.current !== requestEpoch) throw new Error('Your session changed. Sign in again.');
        await secureSessionStore.write(updated);
        if (sessionEpoch.current !== requestEpoch) throw new Error('Your session changed. Sign in again.');
        setTokens(updated);
      });
    },
  }), [ready, tokens]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider.');
  return value;
}
