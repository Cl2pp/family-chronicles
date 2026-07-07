'use client';

import { Card, Select } from '@mantine/core';
import { useI18n, setLocaleCookie } from '@/lib/i18n/client';
import { isLocale, LOCALES, LOCALE_NAMES } from '@/lib/i18n/config';

/** UI-language picker; persists to the locale cookie and reloads the app. */
export function LanguageCard() {
  const { locale, t } = useI18n();

  function changeLocale(value: string | null) {
    if (!isLocale(value) || value === locale) return;
    setLocaleCookie(value);
    // Full reload rather than router.refresh(): it clears the client router
    // cache, so previously visited routes can't flash old-language payloads.
    window.location.reload();
  }

  return (
    <Card withBorder radius="md" p="lg">
      <Select
        label={t.settings.uiLanguageLabel}
        description={t.settings.uiLanguageDescription}
        value={locale}
        onChange={changeLocale}
        data={LOCALES.map((l) => ({ value: l, label: LOCALE_NAMES[l] }))}
        allowDeselect={false}
        maw={280}
      />
    </Card>
  );
}
