import { getI18n } from '@/lib/i18n/server';
import { BrandGlyph } from '@/components/brand-glyph';
import { LandingTopbar } from '../landing-topbar';
import s from '../landing.module.css';

/**
 * Public chrome for the legal pages (Impressum, Datenschutz). Reuses the
 * rebrand's landing shell (`s.page`/`s.wrap`, paper background, brand fonts)
 * and its top bar + footer so a visitor moving from the landing page into a
 * legal page sees no seam. Unlike the (auth) layout it never redirects — these
 * must be reachable by anyone to satisfy the German Impressumspflicht.
 *
 * The top bar is pointed home (`logoHref="/"`, no section links), since the
 * landing page's in-page anchors don't exist on these routes.
 *
 * The content is German-only (Impressum/Datenschutz are German legal
 * artifacts), so `lang="de"` is pinned on the article regardless of UI locale.
 */
export default async function LegalLayout({ children }: { children: React.ReactNode }) {
  const { t } = await getI18n();
  const h = t.home;

  return (
    <div className={s.page}>
      <div className={s.wrap}>
        <LandingTopbar logoHref="/" showSections={false} />

        <main lang="de" style={{ maxWidth: 720, margin: '0 auto', padding: '32px 0 8px' }}>
          {children}
        </main>

        <footer className={s.footer}>
          <div className={s.footerBrand}>
            <BrandGlyph size={18} />
            <span>{h.footerTagline}</span>
          </div>
          <div className={s.footerLinks}>
            <a href="/impressum">{h.footerImprint}</a>
            <a href="/datenschutz">{h.footerPrivacy}</a>
          </div>
        </footer>
      </div>
    </div>
  );
}
