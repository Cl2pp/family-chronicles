'use client';

import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { ServiceWorkerRegister } from '@/components/sw-register';
import { theme } from './theme';

/**
 * App-wide client providers. Color scheme is forced to light for now —
 * approachable and easy to read; dark mode can come later.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <MantineProvider theme={theme} forceColorScheme="light">
      <Notifications />
      <ServiceWorkerRegister />
      {children}
    </MantineProvider>
  );
}
