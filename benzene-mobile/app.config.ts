import type { ExpoConfig } from 'expo/config';

const exampleIdentifier = 'com.example.benzene';
const productionBuild = process.env.EAS_BUILD_PROFILE === 'production';
const easProjectId = process.env.EAS_PROJECT_ID?.trim();

if (productionBuild && (!easProjectId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(easProjectId))) {
  throw new Error('EAS_PROJECT_ID must be the UUID of the publisher-owned EAS project for production builds.');
}

function appIdentifier(environmentName: string): string {
  const value = process.env[environmentName]?.trim();
  const validIdentifier = environmentName === 'ANDROID_APPLICATION_ID'
    ? /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(value ?? '')
    : /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value ?? '');
  const placeholder = (value ?? '').split('.').some((part: string) => ['example', 'placeholder', 'changeme', 'yourcompany'].includes(part.toLowerCase()));
  if (productionBuild && (!value || !validIdentifier || placeholder || value === exampleIdentifier || value.startsWith('com.example.'))) {
    throw new Error(`${environmentName} must be set to an identifier owned by the publisher for production builds.`);
  }
  return value || exampleIdentifier;
}

function requireProductionUrl(environmentName: string, originOnly = false): void {
  if (!productionBuild) return;
  const value = process.env[environmentName]?.trim();
  if (!value) throw new Error(`${environmentName} must be set for production builds.`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${environmentName} must be a public HTTPS URL for production builds.`);
  }
  const hostname = parsed.hostname.toLowerCase();
  const octets = hostname.split('.').map(Number);
  const privateIpv4 = octets.length === 4 && octets.every((part, index) => Number.isInteger(part) && part >= 0 && part <= 255 && String(part) === hostname.split('.')[index]) && (
    octets[0] === 0 || octets[0] === 10 || octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
  );
  const localHost = hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname === '127.0.0.1' || hostname === '[::1]' || privateIpv4 ||
    (hostname.startsWith('[') && (/^\[(?:fc|fd|fe8|fe9|fea|feb)/i.test(hostname) || hostname === '[::]'));
  const placeholderHost = hostname.endsWith('.invalid') || hostname === 'invalid' || hostname === 'example.com' || hostname.endsWith('.example.com') || hostname.endsWith('.example') || hostname.endsWith('.test');
  const rootPath = !originOnly || parsed.pathname === '/' || parsed.pathname === '';
  if (
    parsed.protocol !== 'https:' ||
    placeholderHost ||
    localHost ||
    !rootPath ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${environmentName} must be a public HTTPS URL for production builds.`);
  }
}

requireProductionUrl('EXPO_PUBLIC_GATEWAY_ORIGIN', true);
requireProductionUrl('EXPO_PUBLIC_PRIVACY_POLICY_URL');
requireProductionUrl('EXPO_PUBLIC_TERMS_OF_SERVICE_URL');
requireProductionUrl('EXPO_PUBLIC_SUPPORT_URL');

const config: ExpoConfig = {
  name: 'Benzene',
  slug: 'benzene-mobile',
  scheme: 'benzene',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'light',
  icon: './assets/images/icon.png',
  ios: {
    supportsTablet: true,
    bundleIdentifier: appIdentifier('IOS_BUNDLE_IDENTIFIER'),
    buildNumber: '1',
    privacyManifests: {
      NSPrivacyAccessedAPITypes: [
        {
          NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp',
          NSPrivacyAccessedAPITypeReasons: ['C617.1', '3B52.1'],
        },
        {
          NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime',
          NSPrivacyAccessedAPITypeReasons: ['35F9.1'],
        },
        {
          NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults',
          NSPrivacyAccessedAPITypeReasons: ['CA92.1'],
        },
      ],
    },
    infoPlist: {
      NSAppTransportSecurity: productionBuild
        ? { NSAllowsArbitraryLoads: false, NSAllowsLocalNetworking: true }
        : {
            NSAllowsArbitraryLoads: true,
            NSExceptionDomains: { localhost: { NSExceptionAllowsInsecureHTTPLoads: true } },
          },
    },
  },
  android: {
    package: appIdentifier('ANDROID_APPLICATION_ID'),
    versionCode: 1,
    blockedPermissions: [
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      'android.permission.SYSTEM_ALERT_WINDOW',
      'android.permission.VIBRATE',
    ],
    adaptiveIcon: {
      backgroundColor: '#f7f7f5',
      foregroundImage: './assets/images/android-icon-foreground.png',
      monochromeImage: './assets/images/android-icon-monochrome.png',
    },
  },
  plugins: ['expo-router', ['expo-secure-store', { faceIDPermission: false }], 'expo-sharing'],
  experiments: { typedRoutes: true },
  ...(easProjectId ? { extra: { eas: { projectId: easProjectId } } } : {}),
  ...(process.env.EAS_OWNER?.trim() ? { owner: process.env.EAS_OWNER.trim() } : {}),
};

export default config;
