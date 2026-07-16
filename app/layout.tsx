import '@mantine/core/styles.css';
import '@mantine/dates/styles.css';
import '@mantine/notifications/styles.css';
import './globals.css';

import type { Metadata, Viewport } from 'next';
import { Space_Grotesk, Outfit } from 'next/font/google';
import { mantineHtmlProps } from '@mantine/core';
import { getLocale } from '@/lib/i18n/server';
import { Providers } from './providers';

// Outfit — body & UI. Space Grotesk — wordmark, headings, titles.
const outfit = Outfit({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-outfit',
});

// Space Grotesk is a display face used only for headings/wordmark, always at 600
// (theme `headings.fontWeight` + every `--fw-font-brand` element) — so we load just
// that one weight instead of four. Outfit (body/UI) keeps 400/500/600/700, which are
// all used across the app.
const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  weight: ['600'],
  display: 'swap',
  variable: '--font-space-grotesk',
});

const SITE_URL = 'https://familienwerk.co';
const DESCRIPTION =
  'Eure Familie schreibt ihr eigenes Buch. Erzählt Erinnerungen — getippt oder gesprochen — und Familienwerk macht daraus ein privates Familienwerk auf einer Zeitleiste, bis zum gedruckten Hardcover. Zweisprachig, nur auf Einladung.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'Familienwerk — Eure Familie schreibt ihr eigenes Buch',
    template: '%s · Familienwerk',
  },
  description: DESCRIPTION,
  applicationName: 'Familienwerk',
  authors: [{ name: 'Familienwerk' }],
  creator: 'Familienwerk',
  publisher: 'Familienwerk',
  category: 'lifestyle',
  keywords: [
    'Familienchronik',
    'Familienbuch',
    'Familiengeschichte',
    'Memoiren',
    'Stammbaum',
    'Sprachnotizen',
    'Familienarchiv',
    'family chronicle',
    'family memoir',
    'family history book',
  ],
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: 'Familienwerk',
    title: 'Familienwerk — Eure Familie schreibt ihr eigenes Buch',
    description: DESCRIPTION,
    url: SITE_URL,
    locale: 'de_DE',
    alternateLocale: ['en_US'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Familienwerk — Eure Familie schreibt ihr eigenes Buch',
    description: DESCRIPTION,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
      'max-video-preview': -1,
    },
  },
  formatDetection: { telephone: false },
  manifest: '/manifest.webmanifest',
  // `title` is the iOS home-screen label when the PWA is added via Safari.
  appleWebApp: { capable: true, title: 'Familienwerk', statusBarStyle: 'default' },
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
  themeColor: '#12c24a',
  width: 'device-width',
  initialScale: 1,
  // iOS zooms the whole page when a focused input renders under 16px; capping the
  // scale disables that focus-zoom while pinch-zoom stays available (iOS 10+ ignores
  // these caps for user-initiated zoom). Belt-and-braces with the 16px input rule
  // in globals.css.
  maximumScale: 1,
  userScalable: false,
  // Chrome/Firefox on Android: shrink the layout viewport (and thus 100dvh) when
  // the keyboard opens, so bottom composers sit above it instead of the browser
  // panning the page. Safari/iOS has no support and keeps its overlay behavior —
  // the chat view compensates via the visualViewport API.
  interactiveWidget: 'resizes-content',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  return (
    <html
      lang={locale}
      className={`${outfit.variable} ${spaceGrotesk.variable}`}
      {...mantineHtmlProps}
    >
      {/* No ColorSchemeScript: the app is forced light and mantineHtmlProps already
          server-renders data-mantine-color-scheme="light"; the client-rendered inline
          <script> only re-set that attribute and triggered React's dev script-tag error. */}
      <body>
        <Providers locale={locale}>{children}</Providers>
      </body>
    </html>
  );
}
