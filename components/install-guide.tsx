'use client';

import { Group, Stack, Text, ThemeIcon } from '@mantine/core';
import {
  IconDeviceMobilePlus,
  IconDotsVertical,
  IconShare2,
  IconSquareRoundedPlus,
} from '@tabler/icons-react';
import { useI18n } from '@/lib/i18n/client';

export function isStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari's non-standard flag, set when launched from the Home Screen.
    ('standalone' in navigator && (navigator as { standalone?: boolean }).standalone === true)
  );
}

export function isIos() {
  // iPadOS 13+ masquerades as macOS but is the only "Mac" with a touch screen.
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

function GuideStep({ icon: Icon, text }: { icon: typeof IconShare2; text: string }) {
  return (
    <Group gap="sm" wrap="nowrap">
      <ThemeIcon size={30} radius="md" variant="light" color="brand" style={{ flexShrink: 0 }}>
        <Icon size={18} stroke={1.8} />
      </ThemeIcon>
      <Text fz={13} lh={1.35}>
        {text}
      </Text>
    </Group>
  );
}

/**
 * The three "add to home screen" steps plus the browser hint, for one platform.
 * Shared by the floating nudge and the Settings section so the wording can
 * never drift between the two places a user might read it.
 */
export function InstallGuideSteps({ platform }: { platform: 'ios' | 'android' }) {
  const { t } = useI18n();
  const steps =
    platform === 'ios'
      ? ([
          [IconShare2, t.pwa.iosStep1],
          [IconSquareRoundedPlus, t.pwa.iosStep2],
          [IconDeviceMobilePlus, t.pwa.iosStep3],
        ] as const)
      : ([
          [IconDotsVertical, t.pwa.androidStep1],
          [IconSquareRoundedPlus, t.pwa.androidStep2],
          [IconDeviceMobilePlus, t.pwa.androidStep3],
        ] as const);

  return (
    <Stack gap="sm">
      {steps.map(([icon, text]) => (
        <GuideStep key={text} icon={icon} text={text} />
      ))}
      <Text fz={12} c="dimmed" lh={1.35}>
        {platform === 'ios' ? t.pwa.iosSafariHint : t.pwa.androidHint}
      </Text>
    </Stack>
  );
}
