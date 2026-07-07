'use client';

import { useRouter } from 'next/navigation';
import { Card, Select } from '@mantine/core';
import { useI18n, setLocaleCookie } from '@/lib/i18n/client';
import { isLocale, LOCALES, LOCALE_NAMES } from '@/lib/i18n/config';

/** UI-language picker; persists to the locale cookie and re-renders the app. */
export function LanguageCard() {
  const router = useRouter();
  const { locale, t } = useI18n();

  function changeLocale(value: string | null) {
    if (!isLocale(value) || value === locale) return;
    setLocaleCookie(value);
    router.refresh();
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
