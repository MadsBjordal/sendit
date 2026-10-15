import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';

export const colors = {
  brand: '#2563eb',
  ink: '#0f172a',
  soft: '#475569',
  faint: '#94a3b8',
  line: '#e2e8f0',
  bg: '#f8fafc',
  green: '#047857',
  amber: '#92400e',
  red: '#b91c1c',
};

export function Button({
  title,
  onPress,
  kind = 'primary',
  disabled,
  busy,
}: {
  title: string;
  onPress(): void;
  kind?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        s.btn,
        kind === 'primary' ? s.btnPrimary : kind === 'danger' ? s.btnDanger : s.btnSecondary,
        (disabled || busy) && { opacity: 0.5 },
        pressed && { opacity: 0.8 },
      ]}
    >
      {busy ? (
        <ActivityIndicator color={kind === 'primary' ? '#fff' : colors.ink} />
      ) : (
        <Text
          style={[
            s.btnText,
            kind === 'primary' && { color: '#fff' },
            kind === 'danger' && { color: colors.red },
          ]}
        >
          {title}
        </Text>
      )}
    </Pressable>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return <View style={s.card}>{children}</View>;
}

export function Label({ children }: { children: ReactNode }) {
  return <Text style={s.label}>{children}</Text>;
}

export function Input(props: TextInputProps) {
  return (
    <TextInput placeholderTextColor={colors.faint} {...props} style={[s.input, props.style]} />
  );
}

export function Note({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn' | 'error' | 'ok';
  children: ReactNode;
}) {
  const bg = { info: '#eff6ff', warn: '#fffbeb', error: '#fef2f2', ok: '#ecfdf5' }[tone];
  const fg = { info: '#1d4ed8', warn: colors.amber, error: colors.red, ok: colors.green }[tone];
  return (
    <View style={[s.note, { backgroundColor: bg }]}>
      <Text style={{ color: fg, fontSize: 15 }}>{children}</Text>
    </View>
  );
}

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: 16, gap: 12 },
  h1: { fontSize: 26, fontWeight: '800', color: colors.ink },
  h2: { fontSize: 18, fontWeight: '700', color: colors.ink },
  text: { fontSize: 16, color: colors.ink },
  muted: { fontSize: 14, color: colors.soft },
  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 16,
    gap: 6,
  },
  label: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.soft,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  input: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 18,
    backgroundColor: '#fff',
    color: colors.ink,
  },
  btn: {
    minHeight: 56,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  btnPrimary: { backgroundColor: colors.brand },
  btnSecondary: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#cbd5e1' },
  btnDanger: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#fecaca' },
  btnText: { fontSize: 18, fontWeight: '700', color: colors.ink },
  note: { borderRadius: 12, padding: 12 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center' },
});
