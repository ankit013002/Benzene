import type { ExpoConfig } from 'expo/config';

const exampleIdentifier = 'com.example.benzene';
const productionBuild = process.env.EAS_BUILD_PROFILE === 'production';

function appIdentifier(environmentName: string): string {
  const value = process.env[environmentName]?.trim();
  if (productionBuild && (!value || value === exampleIdentifier || value.startsWith('com.example.'))) {
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
  const loopbackHost = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  const rootPath = !originOnly || parsed.pathname === '/' || parsed.pathname === '';
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname.endsWith('.invalid') ||
    loopbackHost ||
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
  },
  android: {
    package: appIdentifier('ANDROID_APPLICATION_ID'),
    versionCode: 1,
    adaptiveIcon: {
      backgroundColor: '#f7f7f5',
      foregroundImage: './assets/images/android-icon-foreground.png',
      monochromeImage: './assets/images/android-icon-monochrome.png',
    },
  },
  plugins: ['expo-router', 'expo-secure-store', 'expo-sharing'],
  experiments: { typedRoutes: true },
};

export default config;
