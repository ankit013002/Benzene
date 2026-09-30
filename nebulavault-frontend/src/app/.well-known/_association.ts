const identifierPattern = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const androidIdentifierPattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const fingerprintPattern = /^(?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}$/;

export function appleAppSiteAssociation(environment: NodeJS.ProcessEnv = process.env) {
  const teamId = environment.APPLE_APP_LINK_TEAM_ID?.trim() ?? '';
  const bundleId = environment.APPLE_APP_LINK_BUNDLE_ID?.trim() ?? '';
  if (!/^[A-Z0-9]{10}$/.test(teamId) || !identifierPattern.test(bundleId)) return null;
  return {
    applinks: {
      apps: [],
      details: [{ appID: `${teamId}.${bundleId}`, paths: ['/reset-password'] }],
    },
  };
}

export function androidAssetLinks(environment: NodeJS.ProcessEnv = process.env) {
  const applicationId = environment.ANDROID_APP_LINK_APPLICATION_ID?.trim() ?? '';
  const rawFingerprints = environment.ANDROID_APP_LINK_SHA256_CERT_FINGERPRINTS?.trim() ?? '';
  const fingerprints = rawFingerprints.split(',').map((fingerprint) => fingerprint.trim());
  if (
    !androidIdentifierPattern.test(applicationId) ||
    fingerprints.length === 0 ||
    fingerprints.some((fingerprint) => !fingerprintPattern.test(fingerprint)) ||
    new Set(fingerprints.map((fingerprint) => fingerprint.toUpperCase())).size !== fingerprints.length
  ) return null;
  return [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: applicationId,
      sha256_cert_fingerprints: fingerprints.map((fingerprint) => fingerprint.toUpperCase()),
    },
  }];
}

export function associationResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
