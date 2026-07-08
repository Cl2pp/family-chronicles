/** Shared by the server page and the client tabs — keep it free of 'use client'. */
export const SETTINGS_TABS = ['account', 'chronicles', 'app'] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

/** Narrow the `?tab=` search param, falling back to the first tab. */
export function resolveSettingsTab(value: string | undefined): SettingsTab {
  return SETTINGS_TABS.includes(value as SettingsTab) ? (value as SettingsTab) : 'account';
}

/** The canonical URL for a tab — `account` is the default, so it stays bare. */
export function settingsTabHref(tab: SettingsTab): string {
  return tab === 'account' ? '/settings' : `/settings?tab=${tab}`;
}
