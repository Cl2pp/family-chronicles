'use client';

import { useEffect, useState } from 'react';
import { Button, CloseButton, Group, Paper, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconDeviceMobilePlus } from '@tabler/icons-react';
import { MOBILE_TABBAR_OFFSET } from '@/components/app-shell';
import { InstallGuideSteps, isIos, isStandalone } from '@/components/install-guide';
import { useI18n } from '@/lib/i18n/client';
import { onPwaInstallPrompt, type BeforeInstallPromptEvent } from '@/lib/pwa-install';

/** sessionStorage key set on dismissal — hides the card for this visit only. */
const DISMISSED_KEY = 'fc-install-prompt-dismissed';

/** Keys of the retired localStorage snooze/settle scheme, cleaned up on sight. */
const LEGACY_KEYS = ['fc-install-prompt-dismissed-at', 'fc-install-prompt-settled'];

function isDismissed() {
  return sessionStorage.getItem(DISMISSED_KEY) === '1';
}

/**
 * Mobile-only card nudging users to add the app to their home screen.
 * iOS has no install API, so "Show me how" swaps the card content for
 * illustrated share-menu steps in place; on Android/Chromium we hold on
 * to `beforeinstallprompt` and trigger the native install dialog.
 *
 * Rendered only inside the logged-in app shell — never on the landing or
 * login/signup pages. As long as the app isn't installed (running in a
 * browser tab, not standalone), the nudge returns on every new visit;
 * dismissing it — the X, "Not now", installing, or finishing the iOS
 * guide — hides it for the rest of the browser session only. Installed
 * users never see it: launches from the home screen are standalone, and
 * Chromium doesn't re-fire `beforeinstallprompt` once installed. The steps
 * stay available under Settings → App (see `settings/install-card.tsx`).
 */
export function InstallPrompt() {
  const { t } = useI18n();
  const [platform, setPlatform] = useState<'ios' | 'android' | null>(null);
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [showGuide, setShowGuide] = useState(false);

  useEffect(() => {
    LEGACY_KEYS.forEach((key) => localStorage.removeItem(key));
    if (isStandalone() || isDismissed()) return;

    // Let the page settle before nudging; the check runs at fire time.
    const timer = setTimeout(() => {
      if (isIos()) setPlatform('ios');
    }, 1500);

    // The browser event usually fired long before this mounts (on the login
    // page's document) — the global capture in `lib/pwa-install.ts` replays it.
    const unsubscribe = onPwaInstallPrompt((e) => {
      setInstallEvent(e);
      setPlatform('android');
    });
    const onInstalled = () => dismiss();
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      clearTimeout(timer);
      unsubscribe();
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  /** Any way out of the card — gone for this visit, back on the next one. */
  function dismiss() {
    sessionStorage.setItem(DISMISSED_KEY, '1');
    setPlatform(null);
  }

  async function install() {
    if (!installEvent) return;
    await installEvent.prompt();
    await installEvent.userChoice;
    dismiss();
  }

  if (!platform) return null;

  return (
    <Paper
      hiddenFrom="sm"
      shadow="md"
      radius="lg"
      p="sm"
      withBorder
      style={{
        position: 'fixed',
        // Every logged-in route shows the mobile tab bar; float above it.
        bottom: MOBILE_TABBAR_OFFSET,
        left: 12,
        right: 12,
        zIndex: 300,
      }}
    >
      {showGuide ? (
        /* iOS guide — replaces the nudge in place */
        <Stack gap="sm">
          <Group justify="space-between" wrap="nowrap" align="flex-start">
            <Text fz={13} fw={600} lh={1.3}>
              {t.pwa.guideTitle}
            </Text>
            <CloseButton size="sm" onClick={dismiss} aria-label={t.pwa.notNow} />
          </Group>
          <InstallGuideSteps platform="ios" />
          <Button fullWidth size="compact-md" onClick={dismiss}>
            {t.pwa.done}
          </Button>
        </Stack>
      ) : (
        <Group gap="sm" wrap="nowrap" align="flex-start">
          <ThemeIcon size={38} radius="md" variant="light" color="brand">
            <IconDeviceMobilePlus size={22} stroke={1.8} />
          </ThemeIcon>
          <Stack gap={6} style={{ flex: 1, minWidth: 0 }}>
            <Text fz={13} fw={600} lh={1.3}>
              {t.pwa.bannerTitle}
            </Text>
            <Text fz={12} c="dimmed" lh={1.35}>
              {t.pwa.bannerBody}
            </Text>
            <Group gap="xs" mt={2}>
              {platform === 'ios' ? (
                <Button size="compact-sm" onClick={() => setShowGuide(true)}>
                  {t.pwa.showMeHow}
                </Button>
              ) : (
                <Button size="compact-sm" onClick={install}>
                  {t.pwa.install}
                </Button>
              )}
              <Button size="compact-sm" variant="subtle" color="gray" onClick={dismiss}>
                {t.pwa.notNow}
              </Button>
            </Group>
          </Stack>
          <CloseButton size="sm" onClick={dismiss} aria-label={t.pwa.notNow} />
        </Group>
      )}
    </Paper>
  );
}
