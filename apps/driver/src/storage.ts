import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { emptyOutbox, type OutboxState } from './outbox';

/** The login token: in the phone's secure keychain (on the web build: browser storage, for testing only). */
export async function getToken(): Promise<string | null> {
  if (Platform.OS === 'web') return globalThis.localStorage?.getItem('pf.token') ?? null;
  return SecureStore.getItemAsync('pf.token');
}

export async function setToken(token: string | null) {
  if (Platform.OS === 'web') {
    if (token) globalThis.localStorage?.setItem('pf.token', token);
    else globalThis.localStorage?.removeItem('pf.token');
    return;
  }
  if (token) await SecureStore.setItemAsync('pf.token', token);
  else await SecureStore.deleteItemAsync('pf.token');
}

export async function loadOutbox(): Promise<OutboxState> {
  try {
    const raw = await AsyncStorage.getItem('pf.outbox');
    return raw ? (JSON.parse(raw) as OutboxState) : emptyOutbox();
  } catch {
    return emptyOutbox();
  }
}

export async function saveOutbox(state: OutboxState) {
  await AsyncStorage.setItem('pf.outbox', JSON.stringify(state));
}

export async function loadJobsCache<T>(): Promise<T | null> {
  const raw = await AsyncStorage.getItem('pf.jobs');
  return raw ? (JSON.parse(raw) as T) : null;
}

export async function saveJobsCache(jobs: unknown) {
  await AsyncStorage.setItem('pf.jobs', JSON.stringify(jobs));
}
