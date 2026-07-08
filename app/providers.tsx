'use client';

import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { InstallPrompt } from '@/components/install-prompt';
import { ServiceWorkerRegister } from '@/components/sw-register';
import { I18nProvider } from '@/lib/i18n/client';
import type { Locale } from '@/lib/i18n/config';
import { theme } from './theme';

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
        {/* Global so the nudge also shows on login/signup, before users are inside the app. */}
        <InstallPrompt />
        {children}
      </MantineProvider>
    </I18nProvider>
  );
}
