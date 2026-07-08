'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Tabs } from '@mantine/core';
import { IconBooks, IconSettings, IconUserCircle } from '@tabler/icons-react';
import { useI18n } from '@/lib/i18n/client';
import { resolveSettingsTab, settingsTabHref } from './tabs';

export function SettingsTabs({
  account,
  chronicles,
  app,
}: {
  account: React.ReactNode;
  chronicles: React.ReactNode;
  app: React.ReactNode;
}) {
  const { t } = useI18n();
  const urlTab = resolveSettingsTab(useSearchParams().get('tab') ?? undefined);
  const [tab, setTab] = useState(urlTab);
  const [lastUrlTab, setLastUrlTab] = useState(urlTab);

  // A navigation to `?tab=…` (e.g. the sidebar user menu) wins over the tab the user
  // last clicked. Derived during render rather than in an effect — no flash of the
  // stale tab. Note replaceState below does not feed useSearchParams, so it won't
  // trip this branch.
  if (urlTab !== lastUrlTab) {
    setLastUrlTab(urlTab);
    setTab(urlTab);
  }

  function handleChange(value: string | null) {
    if (!value) return;
    const next = resolveSettingsTab(value);
    setTab(next);
    // replaceState, not router.replace: the panels are already rendered, so switching
    // a tab should update the URL without a server round-trip.
    window.history.replaceState(null, '', settingsTabHref(next));
  }

  return (
    <Tabs value={tab} onChange={handleChange} keepMounted={false}>
      <Tabs.List mb="lg">
        <Tabs.Tab value="account" leftSection={<IconUserCircle size={16} />}>
          {t.account.title}
        </Tabs.Tab>
        <Tabs.Tab value="chronicles" leftSection={<IconBooks size={16} />}>
          {t.settings.chroniclesTitle}
        </Tabs.Tab>
        <Tabs.Tab value="app" leftSection={<IconSettings size={16} />}>
          {t.settings.appTitle}
        </Tabs.Tab>
      </Tabs.List>

      <Tabs.Panel value="account">{account}</Tabs.Panel>
      <Tabs.Panel value="chronicles">{chronicles}</Tabs.Panel>
      <Tabs.Panel value="app">{app}</Tabs.Panel>
    </Tabs>
  );
}
