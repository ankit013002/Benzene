import { gatewayOrigin } from '../config';
import type { TokenPair } from '../session/sessionStore';

export class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

export class NativeAuthContractError extends Error {
  constructor() {
    super('Native sign-in is not enabled on this Benzene server yet. The server must issue a short-lived access token and a rotating refresh token in its native-auth response.');
    this.name = 'NativeAuthContractError';
  }
}

const refreshFlights = new Map<string, Promise<TokenPair>>();
const recentRefreshes = new Map<string, { tokens: TokenPair; at: number }>();
const REFRESH_CACHE_MS = 60_000;
const REFRESH_CACHE_LIMIT = 10;
let refreshCacheEpoch = 0;

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseNativeTokens(payload: unknown, now = Date.now()): TokenPair {
  if (!isRecord(payload) || typeof payload.accessToken !== 'string' || !payload.accessToken
    || typeof payload.refreshToken !== 'string' || !payload.refreshToken
    || payload.tokenType !== 'Bearer'
    || typeof payload.expiresInSeconds !== 'number' || !Number.isFinite(payload.expiresInSeconds)
    || payload.expiresInSeconds <= 0) {
    throw new NativeAuthContractError();
  }
  return {
    accessToken: payload.accessToken,
    refreshToken: payload.refreshToken,
    accessTokenExpiresAt: now + payload.expiresInSeconds * 1000,
  };
}

async function refreshTokens(origin: string, tokens: TokenPair): Promise<TokenPair> {
  const cached = recentRefreshes.get(tokens.refreshToken);
  if (cached && Date.now() - cached.at < REFRESH_CACHE_MS) return cached.tokens;
  for (const [key, value] of recentRefreshes) {
    if (Date.now() - value.at >= REFRESH_CACHE_MS) recentRefreshes.delete(key);
  }
  const existing = refreshFlights.get(tokens.refreshToken);
  if (existing) return existing;
  const epochAtStart = refreshCacheEpoch;

  const flight = (async () => {
    let response: Response;
    try {
      response = await fetch(`${origin}/auth/native/refresh`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'X-Benzene-Client-Kind': 'native-mobile' },
        body: JSON.stringify({ refreshToken: tokens.refreshToken }),
      });
    } catch {
      throw new ApiError('Could not reach Benzene. Check your connection and try again.');
    }
    if (!response.ok) throw new ApiError('Your session has expired. Sign in again.', response.status);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new NativeAuthContractError();
    }
    const updated = parseNativeTokens(body);
    if (epochAtStart === refreshCacheEpoch) {
      recentRefreshes.set(tokens.refreshToken, { tokens: updated, at: Date.now() });
      while (recentRefreshes.size > REFRESH_CACHE_LIMIT) {
        const oldest = recentRefreshes.keys().next().value;
        if (!oldest) break;
        recentRefreshes.delete(oldest);
      }
    }
    return updated;
  })();
  refreshFlights.set(tokens.refreshToken, flight);
  try {
    return await flight;
  } finally {
    refreshFlights.delete(tokens.refreshToken);
  }
}

export function clearRefreshCache(): void {
  refreshCacheEpoch += 1;
  refreshFlights.clear();
  recentRefreshes.clear();
}

async function responseError(response: Response, fallback: string): Promise<ApiError> {
  let message = fallback;
  try {
    const payload: unknown = await response.json();
    if (isRecord(payload) && typeof payload.message === 'string' && payload.message.trim()) message = payload.message;
  } catch {
    // Preserve the route-specific fallback if an error response is not JSON.
  }
  return new ApiError(message, response.status);
}

export async function requestJson<T>(
  path: string,
  tokens: TokenPair,
  onTokensUpdated: (tokens: TokenPair) => Promise<void>,
  requestInit: RequestInit = {},
): Promise<T> {
  const origin = gatewayOrigin();
  if (!origin) throw new ApiError('Set a valid HTTPS EXPO_PUBLIC_GATEWAY_ORIGIN to connect Benzene.');
  let active = tokens;
  if (active.accessTokenExpiresAt <= Date.now() + 30_000) {
    active = await refreshTokens(origin, active);
    await onTokensUpdated(active);
  }
  let response: Response;
  const authenticatedHeaders = (accessToken: string): Headers => {
    const headers = new Headers(requestInit.headers);
    headers.set('accept', 'application/json');
    headers.set('authorization', `Bearer ${accessToken}`);
    return headers;
  };
  try {
    response = await fetch(`${origin}${path}`, {
      ...requestInit,
      headers: authenticatedHeaders(active.accessToken),
    });
  } catch {
    throw new ApiError('Could not reach Benzene. Check your connection and try again.');
  }
  if (response.status === 401) {
    active = await refreshTokens(origin, active);
    await onTokensUpdated(active);
    try {
      response = await fetch(`${origin}${path}`, {
        ...requestInit,
        headers: authenticatedHeaders(active.accessToken),
      });
    } catch {
      throw new ApiError('Could not reach Benzene. Check your connection and try again.');
    }
  }
  if (!response.ok) throw await responseError(response, response.status === 401 ? 'Your session has expired. Sign in again.' : 'Benzene could not load this information.');
  try {
    return await response.json() as T;
  } catch {
    throw new ApiError('Benzene returned an unreadable response.', response.status);
  }
}

export async function signIn(email: string, password: string): Promise<{ tokens: TokenPair; emailVerified: boolean }> {
  const origin = gatewayOrigin();
  if (!origin) throw new ApiError('Set a valid HTTPS EXPO_PUBLIC_GATEWAY_ORIGIN to connect Benzene.');
  let response: Response;
  try {
    response = await fetch(`${origin}/auth/native/login`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'X-Benzene-Client-Kind': 'native-mobile' },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    throw new ApiError('Could not reach Benzene. Check your connection and try again.');
  }
  if (!response.ok) {
    if (response.status === 404 || response.status === 405) throw new NativeAuthContractError();
    if (response.status === 403) {
      throw new ApiError('Confirm your email from the Benzene verification message, then sign in again.', 403);
    }
    if (response.status === 401) throw new ApiError('Email or password is incorrect.', 401);
    throw new ApiError('Benzene could not sign you in.', response.status);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new NativeAuthContractError();
  }
  if (!isRecord(payload)) throw new NativeAuthContractError();
  const tokens = parseNativeTokens(payload);
  if (payload.emailVerified !== true) {
    try {
      await fetch(`${origin}/auth/native/logout`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'X-Benzene-Client-Kind': 'native-mobile' },
        body: JSON.stringify({ refreshToken: tokens.refreshToken }),
      });
    } catch {
      // The unverified token pair is never stored on the device.
    }
    throw new ApiError('Confirm your email from the Benzene verification message, then sign in again.');
  }
  return { tokens, emailVerified: true };
}
