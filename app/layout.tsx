import '@mantine/core/styles.css';
import '@mantine/dates/styles.css';
import '@mantine/notifications/styles.css';
import './globals.css';

import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { mantineHtmlProps } from '@mantine/core';
import { getLocale } from '@/lib/i18n/server';
import { Providers } from './providers';

const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-inter',
});

export const metadata: Metadata = {
  title: 'Family Chronicle',
  description: 'A private vault where your family stories live.',
  manifest: '/manifest.webmanifest',
  // `title` is the iOS home-screen label when the PWA is added via Safari.
  appleWebApp: { capable: true, title: 'Chronicles', statusBarStyle: 'default' },
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180' }],
  },
};

export const viewport: Viewport = {
  themeColor: '#2563eb',
  width: 'device-width',
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale} className={inter.variable} {...mantineHtmlProps}>
      {/* No ColorSchemeScript: the app is forced light and mantineHtmlProps already
          server-renders data-mantine-color-scheme="light"; the client-rendered inline
          <script> only re-set that attribute and triggered React's dev script-tag error. */}
      <body>
        <Providers locale={locale}>{children}</Providers>
      </body>
    </html>
  );
}
