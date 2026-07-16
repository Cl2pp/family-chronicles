'use client';

import { useSyncExternalStore } from 'react';
import { Box, Card, Group, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { IconCircleCheck, IconDeviceMobilePlus } from '@tabler/icons-react';
import { InstallGuideSteps, isIos, isStandalone } from '@/components/install-guide';
import { useI18n } from '@/lib/i18n/client';

type Platform = 'ios' | 'android' | 'installed';

/** Nothing to subscribe to: display mode and user agent are fixed for this page load. */
const neverChanges = () => () => {};

let cached: Platform | undefined;

/** Must return a stable reference across renders, hence the cache. */
function getPlatform(): Platform {
  cached ??= isStandalone() ? 'installed' : isIos() ? 'ios' : 'android';
  return cached;
}

/**
 * Settings → App section explaining how to put the app on the home screen.
 * The floating nudge (`components/install-prompt.tsx`) hides for the rest of
 * the session once dismissed; this is the permanent place to look the steps
 * up again. Mobile only — there is no home screen to add to on a desktop
 * browser.
 */
export function InstallCard() {
  const { t } = useI18n();
  // Platform sniffing needs `window`, so the server (and first hydration pass)
  // renders nothing and the real value lands on the next commit.
  const state = useSyncExternalStore(neverChanges, getPlatform, () => null);

  if (!state) return null;

  return (
    <Box hiddenFrom="sm">
      <Title order={3} mb="xs">
        {t.settings.installTitle}
      </Title>
      <Card withBorder radius="md" p="lg">
        {state === 'installed' ? (
          <Group gap="sm" wrap="nowrap">
            <ThemeIcon size={30} radius="md" variant="light" color="brand">
              <IconCircleCheck size={18} stroke={1.8} />
            </ThemeIcon>
            <Text fz={13} lh={1.35}>
              {t.pwa.alreadyInstalled}
            </Text>
          </Group>
        ) : (
          <Stack gap="md">
            <Group gap="sm" wrap="nowrap" align="flex-start">
              <ThemeIcon size={38} radius="md" variant="light" color="brand">
                <IconDeviceMobilePlus size={22} stroke={1.8} />
              </ThemeIcon>
              <Text fz={12} c="dimmed" lh={1.35} style={{ flex: 1, minWidth: 0 }}>
                {t.pwa.bannerBody}
              </Text>
            </Group>
            <InstallGuideSteps platform={state} />
          </Stack>
        )}
      </Card>
    </Box>
  );
}
