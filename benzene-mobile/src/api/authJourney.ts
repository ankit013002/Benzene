import { gatewayOrigin } from '../config';
import { isRecord } from './client';

export class AuthJourneyError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'AuthJourneyError';
  }
}

type AuthResponse = { ok: true; emailVerified?: false };

function messageForStatus(status: number, fallback: string): string {
  if (status === 400) return 'Check the information and try again.';
  if (status === 409) return 'An account already exists for this email. Sign in or reset your password.';
  if (status === 429) return 'Too many attempts. Wait a while and try again.';
  if (status === 401 || status === 403) return 'The email or password could not be confirmed.';
  return fallback;
}

export function mapAuthJourneyError(status: number, fallback: string): string {
  return messageForStatus(status, fallback);
}

async function postAuth<T>(path: string, payload: Record<string, string>, fallback: string): Promise<T> {
  const origin = gatewayOrigin();
  if (!origin) throw new AuthJourneyError('Set a valid HTTPS EXPO_PUBLIC_GATEWAY_ORIGIN to connect Benzene.');
  let response: Response;
  try {
    response = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'X-Benzene-Client-Kind': 'native-mobile',
      },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new AuthJourneyError('Could not reach Benzene. Check your connection and try again.');
  }
  if (!response.ok) throw new AuthJourneyError(messageForStatus(response.status, fallback), response.status);
  try {
    const body: unknown = await response.json();
    if (!isRecord(body) || body.ok !== true) throw new Error('invalid response');
    return body as T;
  } catch {
    throw new AuthJourneyError('Benzene returned an unreadable response.', response.status);
  }
}

export function signUp(email: string, password: string): Promise<AuthResponse> {
  return postAuth('/auth/native/signup', { email: email.trim().toLowerCase(), password }, 'Benzene could not create your account.');
}

export function resendVerification(email: string, password: string): Promise<AuthResponse> {
  return postAuth('/auth/native/resend-verification', { email: email.trim().toLowerCase(), password }, 'Benzene could not send a verification message.');
}

export function requestPasswordReset(email: string): Promise<AuthResponse> {
  return postAuth('/auth/forgot-password', { email: email.trim().toLowerCase() }, 'Benzene could not process this request.');
}

export function resetPassword(token: string, newPassword: string): Promise<AuthResponse> {
  return postAuth('/auth/reset-password', { token: token.trim(), newPassword }, 'Benzene could not reset your password.');
}

export function resetTokenFromInput(value: string): string | null {
  const input = value.trim();
  if (!input) return null;
  if (!/^https?:\/\//i.test(input)) {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? null : input;
  }

  try {
    const link = new URL(input);
    if (!['http:', 'https:'].includes(link.protocol) || !link.pathname.endsWith('/reset-password')) return null;
    return link.searchParams.get('token')?.trim() || null;
  } catch {
    return null;
  }
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export function passwordLengthError(password: string): string | null {
  return password.length >= 8 ? null : 'Use at least 8 characters for your password.';
}
