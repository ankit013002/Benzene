export function gatewayOrigin(): string | null {
  const value = process.env.EXPO_PUBLIC_GATEWAY_ORIGIN?.trim();
  if (!value) return null;

  try {
    const parsed = new URL(value);
    const localHost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    const rootPath = parsed.pathname === '/' || parsed.pathname === '';
    if (parsed.hostname.endsWith('.invalid')) return null;
    if (!rootPath || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    if (parsed.protocol !== 'https:' && (process.env.NODE_ENV === 'production' || !localHost)) {
      return null;
    }
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

export function privacyPolicyUrl(): string | null {
  return configuredPublicUrl('EXPO_PUBLIC_PRIVACY_POLICY_URL');
}

export function termsOfServiceUrl(): string | null {
  return configuredPublicUrl('EXPO_PUBLIC_TERMS_OF_SERVICE_URL');
}

export function supportUrl(): string | null {
  return configuredPublicUrl('EXPO_PUBLIC_SUPPORT_URL');
}

function configuredPublicUrl(environmentName: string): string | null {
  const value = process.env[environmentName]?.trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.hostname.endsWith('.invalid') && !parsed.username && !parsed.password && !parsed.hash
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}
