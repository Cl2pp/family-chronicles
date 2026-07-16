'use client';

import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { DeploymentGuard } from '@/components/deployment-guard';
import { ServiceWorkerRegister } from '@/components/sw-register';
import { I18nProvider } from '@/lib/i18n/client';
import type { Locale } from '@/lib/i18n/config';
import { capturePwaInstallPrompt } from '@/lib/pwa-install';
import { theme } from './theme';

// Chromium fires `beforeinstallprompt` once per document, often while the
// user is still on the login page — stash it now so the install nudge
// inside the app (see `app/(app)/layout.tsx`) can still use it after a
// client-side navigation.
capturePwaInstallPrompt();

/**
 * App-wide client providers. Color scheme is forced to light for now —
 * approachable and easy to read; dark mode can come later.
 */
export function Providers({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  return (
    <I18nProvider locale={locale}>
      <MantineProvider theme={theme} forceColorScheme="light">
        <Notifications />
        <ServiceWorkerRegister />
        <DeploymentGuard />
        {children}
      </MantineProvider>
    </I18nProvider>
  );
}
