import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { call, Offline } from '../api';
import { t } from '../i18n';
import { setToken } from '../storage';
import { Button, Input, Label, Note, s } from '../ui';

export function Login({ onDone }: { onDone(): void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await call<{ token?: string }>('/api/auth/token', {
        method: 'POST',
        body: { email: email.trim(), password },
      });
      if (r.status === 200 && r.data.token) {
        await setToken(r.data.token);
        onDone();
      } else setError(t('login.failed'));
    } catch (e) {
      setError(e instanceof Offline ? t('login.offline') : t('login.failed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ScrollView contentContainerStyle={[s.scroll, { paddingTop: 64 }]}>
      <Text style={s.h1}>{t('login.title')}</Text>
      <View style={{ gap: 6 }}>
        <Label>{t('login.email')}</Label>
        <Input
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          autoComplete="email"
          accessibilityLabel={t('login.email')}
        />
      </View>
      <View style={{ gap: 6 }}>
        <Label>{t('login.password')}</Label>
        <Input
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="password"
          accessibilityLabel={t('login.password')}
          onSubmitEditing={submit}
        />
      </View>
      {error && <Note tone="error">{error}</Note>}
      <Button
        title={t('login.submit')}
        onPress={submit}
        busy={busy}
        disabled={!email || !password}
      />
    </ScrollView>
  );
}
