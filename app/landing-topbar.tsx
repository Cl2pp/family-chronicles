'use client';

import { Group, Button, SegmentedControl } from '@mantine/core';
import { useI18n, setLocaleCookie } from '@/lib/i18n/client';
import { isLocale, LOCALES, LOCALE_NAMES } from '@/lib/i18n/config';

/**
 * Marketing-page top bar: brand mark, a compact language switch, and the
 * sign-in button. Client-side so the language toggle can persist the cookie
 * and reload; the rest of the landing page stays a server component.
 */
export function LandingTopbar() {
  const { locale, t } = useI18n();

  function changeLocale(value: string) {
    if (!isLocale(value) || value === locale) return;
    setLocaleCookie(value);
    window.location.reload();
  }

  return (
    <Group justify="space-between" align="center" wrap="nowrap">
      <Group gap="xs" align="center" wrap="nowrap">
        <BrandMark />
      </Group>
      <Group gap="sm" align="center" wrap="nowrap">
        <SegmentedControl
          size="xs"
          value={locale}
          onChange={changeLocale}
          data={LOCALES.map((l) => ({ value: l, label: LOCALE_NAMES[l] }))}
          visibleFrom="xs"
        />
        <Button component="a" href="/login" size="sm" variant="default">
          {t.home.signIn}
        </Button>
      </Group>
    </Group>
  );
}

function BrandMark() {
  return (
    <Group gap={8} align="center" wrap="nowrap">
      <svg width="26" height="26" viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <rect x="2" y="2" width="28" height="28" rx="8" fill="var(--mantine-color-brand-6)" />
        <path
          d="M10 9.5A1.5 1.5 0 0 1 11.5 8H22v14.5H11.5A1.5 1.5 0 0 0 10 24V9.5Z"
          fill="white"
          opacity="0.95"
        />
        <path d="M13 12h6M13 15h6M13 18h4" stroke="var(--mantine-color-brand-6)" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      <span style={{ fontWeight: 600, fontSize: 17, color: 'var(--mantine-color-slate-8)' }}>
        Familienwerk
      </span>
    </Group>
  );
}
