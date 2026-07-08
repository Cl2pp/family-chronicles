'use client';

import { useEffect, useState } from 'react';
import {
  Button,
  CloseButton,
  Group,
  Modal,
  Paper,
  Stack,
  Text,
  ThemeIcon,
} from '@mantine/core';
import { IconDeviceMobilePlus, IconShare2, IconSquareRoundedPlus } from '@tabler/icons-react';
import { useI18n } from '@/lib/i18n/client';

/** Chromium fires this before showing its own install UI; not in the TS DOM lib yet. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISSED_KEY = 'fc-install-prompt-dismissed-at';
const SNOOZE_DAYS = 30;

function isSnoozed() {
  const at = Number(localStorage.getItem(DISMISSED_KEY));
  return at > 0 && Date.now() - at < SNOOZE_DAYS * 24 * 60 * 60 * 1000;
}

function isStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari's non-standard flag, set when launched from the Home Screen.
    ('standalone' in navigator && (navigator as { standalone?: boolean }).standalone === true)
  );
}

function isIos() {
  // iPadOS 13+ masquerades as macOS but is the only "Mac" with a touch screen.
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

/**
 * Mobile-only banner nudging users to put the app on their home screen.
 * iOS has no install API, so the banner opens illustrated share-menu steps;
 * on Android/Chromium we hold on to `beforeinstallprompt` and trigger the
 * native install dialog. Dismissing snoozes the banner for 30 days.
 */
export function InstallPrompt() {
  const { t } = useI18n();
  const [platform, setPlatform] = useState<'ios' | 'android' | null>(null);
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);

  useEffect(() => {
    if (isStandalone() || isSnoozed()) return;

    if (isIos()) {
      // Let the page settle before nudging.
      const timer = setTimeout(() => setPlatform('ios'), 1500);
      return () => clearTimeout(timer);
    }

    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallEvent(e as BeforeInstallPromptEvent);
      setPlatform('android');
    };
    const onInstalled = () => setPlatform(null);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  function dismiss() {
    localStorage.setItem(DISMISSED_KEY, String(Date.now()));
    setPlatform(null);
  }

  async function install() {
    if (!installEvent) return;
    await installEvent.prompt();
    const { outcome } = await installEvent.userChoice;
    if (outcome === 'accepted') setPlatform(null);
    else dismiss();
  }

  if (!platform) return null;

  return (
    <>
      <Paper
        hiddenFrom="sm"
        shadow="md"
        radius="lg"
        p="sm"
        withBorder
        style={{
          position: 'fixed',
          bottom: 72,
          left: 12,
          right: 12,
          zIndex: 300,
        }}
      >
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
                <Button size="compact-sm" onClick={() => setGuideOpen(true)}>
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
      </Paper>

      {/* iOS step-by-step guide */}
      <Modal
        opened={guideOpen}
        onClose={() => setGuideOpen(false)}
        title={t.pwa.guideTitle}
        centered
        radius="lg"
      >
        <Stack gap="md">
          <Group gap="sm" wrap="nowrap">
            <ThemeIcon size={34} radius="md" variant="light" color="brand">
              <IconShare2 size={20} stroke={1.8} />
            </ThemeIcon>
            <Text fz={14}>{t.pwa.iosStep1}</Text>
          </Group>
          <Group gap="sm" wrap="nowrap">
            <ThemeIcon size={34} radius="md" variant="light" color="brand">
              <IconSquareRoundedPlus size={20} stroke={1.8} />
            </ThemeIcon>
            <Text fz={14}>{t.pwa.iosStep2}</Text>
          </Group>
          <Group gap="sm" wrap="nowrap">
            <ThemeIcon size={34} radius="md" variant="light" color="brand">
              <IconDeviceMobilePlus size={20} stroke={1.8} />
            </ThemeIcon>
            <Text fz={14}>{t.pwa.iosStep3}</Text>
          </Group>
          <Text fz={12} c="dimmed">
            {t.pwa.iosSafariHint}
          </Text>
          <Button
            fullWidth
            onClick={() => {
              setGuideOpen(false);
              dismiss();
            }}
          >
            {t.pwa.done}
          </Button>
        </Stack>
      </Modal>
    </>
  );
}
