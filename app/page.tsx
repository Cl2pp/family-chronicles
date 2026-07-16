import { redirect } from 'next/navigation';
import { getI18n } from '@/lib/i18n/server';
import { getSession } from '@/lib/session';
import { LandingTopbar } from './landing-topbar';
import {
  BrandGlyph,
  MicGlyph,
  HeroArt,
  PersonGlyph,
  IconSpeak,
  IconMemoir,
  IconPhotos,
  IconChat,
} from './landing-graphics';
import s from './landing.module.css';

export default async function Home() {
  // The PWA's start_url is "/" — a signed-in user cold-starting the pinned app
  // must land in the app, not on the marketing page with a sign-in button.
  const session = await getSession();
  if (session?.user) redirect('/chat');

  const { t } = await getI18n();
  const h = t.home;

  const features = [
    { icon: <IconSpeak />, title: h.featureSpeakTitle, text: h.featureSpeakText },
    { icon: <IconMemoir />, title: h.featureMemoirTitle, text: h.featureMemoirText },
    { icon: <IconPhotos />, title: h.featurePhotosTitle, text: h.featurePhotosText },
    { icon: <IconChat />, title: h.featureChatTitle, text: h.featureChatText },
  ];

  // Timeline rows — years with representative bar widths; the last is "now".
  const timeline = [
    { year: '1948', bar: 150 },
    { year: '1971', bar: 110 },
    { year: '1994', bar: 170 },
    { year: '2026', bar: 130, now: true },
  ];

  // Family-tree leaves — surname tags derived automatically (see lib/family-tags).
  const branches = [
    { ring: '#A9E9A0', person: '#5FCB5A', name: 'Müller' },
    { ring: '#0C8038', person: '#0C8038', name: 'Schneider' },
    { ring: '#12C24A', person: '#12C24A', name: 'Fischer' },
  ];

  return (
    <div id="top" className={s.page}>
      <div className={s.wrap}>
        <LandingTopbar />

        {/* ── Hero ─────────────────────────────────────────────── */}
        <header className={s.hero}>
          <div className={s.heroCopy}>
            <span className={s.eyebrow}>{h.eyebrow}</span>
            <h1 className={s.h1}>{h.heroTitle}</h1>
            <p className={s.lead} style={{ maxWidth: 480 }}>
              {h.heroSubtitle}
            </p>
            <div className={s.heroCtas}>
              <a className={`${s.btnPrimary} ${s.btnMd}`} href="/signup">
                {h.ctaPrimary}
              </a>
              <a className={`${s.btnGhost} ${s.btnMd}`} href="#funktionen">
                {h.ctaSecondary}
              </a>
            </div>
            <div className={s.trust}>
              <span className={s.avatars}>
                <span className={s.avatar} style={{ background: '#E9FAE5', color: '#0C8038' }}>
                  MM
                </span>
                <span className={s.avatar} style={{ background: '#17211C', color: '#fff' }}>
                  KM
                </span>
                <span className={s.avatar} style={{ background: '#12C24A', color: '#fff' }}>
                  LF
                </span>
              </span>
              {h.heroTrust}
            </div>
          </div>
          <div className={s.heroArt}>
            <HeroArt />
          </div>
        </header>

        {/* ── How it works ─────────────────────────────────────── */}
        <section className={s.how}>
          <div className={s.howCopy}>
            <span className={s.eyebrow}>{h.howEyebrow}</span>
            <h2 className={s.h2}>{h.howTitle}</h2>
            <p className={s.lead}>{h.howText}</p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className={s.voiceRow}>
              <span className={s.voiceIcon}>
                <MicGlyph size={16} color="#fff" />
              </span>
              <div>
                <div className={s.voiceLabel}>{h.demoVoiceLabel}</div>
                <div className={s.voiceQuote}>{h.demoVoiceQuote}</div>
              </div>
            </div>
            <div className={s.arrowNote}>
              <span className={s.arrowBadge}>↓</span>
              {h.demoArrow}
            </div>
            <div className={s.storyCard}>
              <div className={s.storyBanner}>
                <span className={s.storyBannerLabel}>[ Bodensee · 1974 ]</span>
              </div>
              <div className={s.storyBody}>
                <div className={s.tagRow}>
                  <span className={s.tag}>Müller</span>
                  <span className={`${s.tag} ${s.tagNeutral}`}>{h.demoTagSeason}</span>
                </div>
                <div className={s.storyTitle}>{h.demoStoryTitle}</div>
                <div className={s.storyText}>{h.demoStoryText}</div>
              </div>
            </div>
          </div>
        </section>

        {/* ── Feature grid ─────────────────────────────────────── */}
        <section id="funktionen" className={s.section}>
          <div className={s.featureHead}>
            <h2 className={s.h2}>{h.featuresTitle}</h2>
            <p className={s.lead}>{h.featuresSubtitle}</p>
          </div>
          <div className={s.featureGrid}>
            {features.map((f) => (
              <div key={f.title} className={s.feature}>
                {f.icon}
                <div className={s.featureTitle}>{f.title}</div>
                <div className={s.featureText}>{f.text}</div>
              </div>
            ))}
          </div>
        </section>

        {/* ── Timeline & Tree ──────────────────────────────────── */}
        <section className={s.showcase}>
          {/* Timeline: viz left, copy right (desktop) */}
          <div className={s.showCard}>
            <div className={s.timeline}>
              <div className={s.timelineRail} />
              {timeline.map((row) => (
                <div key={row.year} className={s.timelineRow}>
                  <span className={`${s.timelineDot} ${row.now ? s.timelineDotNow : ''}`} />
                  <span className={s.yearChip}>{row.year}</span>
                  <span className={s.bar} style={{ width: row.bar }} />
                </div>
              ))}
            </div>
            <div className={s.showCopy}>
              <h3 className={s.showTitle}>{h.timelineTitle}</h3>
              <p className={s.showText}>{h.timelineText}</p>
            </div>
          </div>

          {/* Tree: copy left, viz right (desktop) — reversed */}
          <div className={`${s.showCard} ${s.showCardReverse}`}>
            <div className={s.tree}>
              <div className={s.treeRow}>
                <span className={s.treeAvatar} style={{ border: '3px solid #12C24A' }}>
                  <PersonGlyph size={28} color="#12C24A" />
                </span>
                <span className={s.treeAvatar} style={{ border: '3px solid #7BE84B' }}>
                  <PersonGlyph size={28} color="#7BE84B" />
                </span>
              </div>
              <div className={s.treeStem} />
              <div className={s.treeBeam} />
              <div className={s.treeLeaves}>
                {branches.map((b) => (
                  <div key={b.name} className={s.treeNode}>
                    <div className={s.treeStem} style={{ height: 16 }} />
                    <span className={s.treeAvatar} style={{ border: `3px solid ${b.ring}` }}>
                      <PersonGlyph size={26} color={b.person} />
                    </span>
                    <span className={s.tag}>{b.name}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className={s.showCopy}>
              <h3 className={s.showTitle}>{h.treeTitle}</h3>
              <p className={s.showText}>{h.treeText}</p>
            </div>
          </div>
        </section>

        {/* ── The book (dark) ──────────────────────────────────── */}
        <section id="buch" className={s.book}>
          <div className={s.bookCopy}>
            <span className={`${s.eyebrow} ${s.eyebrowDark}`}>{h.bookEyebrow}</span>
            <h2 className={s.bookTitle}>{h.bookTitle}</h2>
            <p className={s.bookText}>{h.bookText}</p>
            <a className={`${s.btnLime} ${s.btnMd} ${s.bookCtaDesktop}`} href="/signup">
              {h.bookCta}
            </a>
          </div>
          <div className={s.bookCoverWrap}>
            <div className={s.bookCover}>
              <BrandGlyph size={36} variant="onGreen" />
              <div className={s.bookCoverTitle}>{h.bookCoverFamily}</div>
              <div className={s.bookCoverSub}>{h.bookCoverSubtitle}</div>
              <div className={s.bookCoverMeta}>{h.bookCoverMeta}</div>
            </div>
          </div>
          <a
            className={`${s.btnLime} ${s.btnMd} ${s.bookCtaMobile}`}
            href="/signup"
            style={{ width: '100%' }}
          >
            {h.bookCta}
          </a>
        </section>

        {/* ── Privacy ──────────────────────────────────────────── */}
        <section id="privat" className={s.privacy}>
          {[
            { n: '1', title: h.privacy1Title, text: h.privacy1Text },
            { n: '2', title: h.privacy2Title, text: h.privacy2Text },
            { n: '3', title: h.privacy3Title, text: h.privacy3Text },
          ].map((p) => (
            <div key={p.n} className={s.privacyItem}>
              <span className={s.privacyNum}>{p.n}</span>
              <div>
                <div className={s.privacyTitle}>{p.title}</div>
                <div className={s.privacyText}>{p.text}</div>
              </div>
            </div>
          ))}
        </section>

        {/* ── Closing CTA ──────────────────────────────────────── */}
        <section className={s.closing}>
          <h2 className={s.closingTitle}>
            {h.closingLine1}
            <br />
            {h.closingLine2}
          </h2>
          <p className={s.closingText}>{h.closingText}</p>
          <a className={`${s.btnPrimary} ${s.btnMd}`} href="/signup">
            {h.closingCta}
          </a>
        </section>

        {/* ── Footer ───────────────────────────────────────────── */}
        <footer className={s.footer}>
          <div className={s.footerBrand}>
            <BrandGlyph size={18} />
            <span>{h.footerTagline}</span>
          </div>
          <div className={s.footerLinks}>
            <a href="#top">{h.footerImprint}</a>
            <a href="#top">{h.footerPrivacy}</a>
          </div>
        </footer>
      </div>
    </div>
  );
}
