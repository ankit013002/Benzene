import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View, type ScrollViewProps } from 'react-native';
import { palette, shadow, type } from '../theme';

export function Screen({ children, scroll = true, ...props }: ScrollViewProps & { children: ReactNode; scroll?: boolean }) {
  if (!scroll) return <View style={styles.screen}>{children}</View>;
  return <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled" {...props}>{children}</ScrollView>;
}

export function Wordmark({ subtitle }: { subtitle?: string }) {
  return (
    <View style={styles.brand}>
      <Text style={styles.wordmark}>BENZENE</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
    </View>
  );
}

export function PageTitle({ title, detail }: { title: string; detail?: string }) {
  return <View style={styles.titleBlock}><Text style={styles.title}>{title}</Text>{detail ? <Text style={styles.detail}>{detail}</Text> : null}</View>;
}

export function Card({ children, style }: { children: ReactNode; style?: object }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Label({ children }: { children: ReactNode }) {
  return <Text style={styles.label}>{children}</Text>;
}

export function Body({ children, style }: { children: ReactNode; style?: object }) {
  return <Text style={[styles.body, style]}>{children}</Text>;
}

export function StateMessage({ title, detail, busy = false }: { title: string; detail?: string; busy?: boolean }) {
  return <Card><Text style={styles.stateTitle}>{busy ? 'Loading' : title}</Text>{detail ? <Body style={styles.stateDetail}>{detail}</Body> : null}</Card>;
}

const styles = StyleSheet.create({
  screen: { flexGrow: 1, backgroundColor: palette.paper, paddingHorizontal: 22, paddingTop: 22, paddingBottom: 32, gap: 18 },
  brand: { gap: 3, marginBottom: 8 },
  wordmark: { color: palette.ink, fontSize: 12, fontWeight: '700', letterSpacing: 2.4 },
  subtitle: { color: palette.muted, fontSize: 12, lineHeight: 18 },
  titleBlock: { gap: 6, marginTop: 4, marginBottom: 2 },
  title: { color: palette.ink, ...type.title },
  detail: { color: palette.muted, ...type.body },
  card: { backgroundColor: palette.card, borderColor: palette.line, borderWidth: StyleSheet.hairlineWidth, borderRadius: 20, padding: 19, gap: 10, ...shadow },
  label: { color: palette.muted, fontSize: 11, fontWeight: '600', letterSpacing: 1.2, textTransform: 'uppercase' },
  body: { color: palette.ink, ...type.body },
  stateTitle: { color: palette.ink, ...type.section },
  stateDetail: { color: palette.muted },
});
