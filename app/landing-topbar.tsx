'use client';

import { SegmentedControl } from '@mantine/core';
import { useI18n, setLocaleCookie } from '@/lib/i18n/client';
import { isLocale, LOCALES, LOCALE_NAMES } from '@/lib/i18n/config';
import { BrandGlyph } from '@/components/brand-glyph';
import s from './landing.module.css';

/**
 * Marketing-page top bar: brand mark, section links, a compact language switch,
 * and the sign-in button. Client-side so the language toggle can persist the
 * cookie and reload; the rest of the landing page stays a server component.
 */
export function LandingTopbar() {
  const { locale, t } = useI18n();
  const h = t.home;

  function changeLocale(value: string) {
    if (!isLocale(value) || value === locale) return;
    setLocaleCookie(value);
    window.location.reload();
  }

  return (
    <nav className={s.nav}>
      <a className={s.logo} href="#top" aria-label="Familienwerk">
        <BrandGlyph size={24} />
        <span className={s.logoWord}>Familienwerk</span>
      </a>
      <div className={s.navRight}>
        <div className={s.navLinks}>
          <a className={s.navLink} href="#funktionen">
            {h.navFeatures}
          </a>
          <a className={s.navLink} href="#buch">
            {h.navBook}
          </a>
          <a className={s.navLink} href="#privat">
            {h.navPrivacy}
          </a>
        </div>
        <SegmentedControl
          size="xs"
          value={locale}
          onChange={changeLocale}
          data={LOCALES.map((l) => ({ value: l, label: LOCALE_NAMES[l] }))}
          aria-label={locale === 'de' ? 'Sprache' : 'Language'}
          visibleFrom="xs"
        />
        <a className={`${s.btnPrimary} ${s.btnSm}`} href="/login">
          {h.signIn}
        </a>
      </div>
    </nav>
  );
}
