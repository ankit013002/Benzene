import { Platform } from 'react-native';

export const palette = {
  paper: '#f7f7f5',
  card: '#ffffff',
  ink: '#171717',
  muted: '#717171',
  line: '#e4e4e1',
  soft: '#efefed',
  danger: '#8d3e3e',
  success: '#456b55',
};

export const type = {
  title: { fontSize: 31, lineHeight: 37, fontWeight: '700' as const, letterSpacing: -0.8 },
  section: { fontSize: 18, lineHeight: 24, fontWeight: '600' as const, letterSpacing: -0.2 },
  body: { fontSize: 15, lineHeight: 22 },
  small: { fontSize: 12, lineHeight: 17 },
};

export const shadow = Platform.select({
  ios: { shadowColor: '#000000', shadowOpacity: 0.035, shadowRadius: 14, shadowOffset: { width: 0, height: 5 } },
  android: { elevation: 1 },
  default: {},
});
