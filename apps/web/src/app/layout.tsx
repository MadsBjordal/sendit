import type { Metadata, Viewport } from 'next';
import './globals.css';
import { AuthProvider } from '@/components/auth';
import { AppShell } from '@/components/AppShell';
import { I18nProvider } from '@/i18n';

export const metadata: Metadata = {
  title: process.env.NEXT_PUBLIC_BRAND_NAME ?? 'Project Freight',
  description: 'Request road freight across Europe as easily as a taxi.',
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#2563eb' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <I18nProvider>
          <AuthProvider>
            <AppShell>{children}</AppShell>
          </AuthProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
