import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';
import { palette } from '../theme';

export function ActionButton({ title, onPress, busy = false, secondary = false, disabled = false }: {
  title: string;
  onPress: () => void;
  busy?: boolean;
  secondary?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable disabled={disabled || busy} onPress={onPress} style={({ pressed }) => [
      styles.button,
      secondary ? styles.secondary : styles.primary,
      (pressed || disabled) && styles.dimmed,
    ]}>
      {busy ? <ActivityIndicator color={secondary ? palette.ink : palette.card} /> : <Text style={[styles.text, secondary ? styles.secondaryText : styles.primaryText]}>{title}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { minHeight: 52, borderRadius: 15, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18 },
  primary: { backgroundColor: palette.ink },
  secondary: { backgroundColor: palette.card, borderColor: palette.line, borderWidth: 1 },
  dimmed: { opacity: 0.55 },
  text: { fontSize: 15, fontWeight: '600' },
  primaryText: { color: palette.card },
  secondaryText: { color: palette.ink },
});
