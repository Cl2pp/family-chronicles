'use client';

import { createTheme, type MantineColorsTuple } from '@mantine/core';

// Familienwerk brand — "Werk Green" (#12C24A). Warm, alive, modern; light-mode only.
// Green is the single accent: primary action, active state, links, tags, record
// indicator. Everything else stays paper/shade/ink so the content is the star.
const brand: MantineColorsTuple = [
  '#e9fae5', // 0 — Green Tint (chips, selection, light badges)
  '#c6f5d5', // 1
  '#97ecb2', // 2
  '#5fe08c', // 3
  '#33d26e', // 4
  '#1cc957', // 5
  '#12c24a', // 6 — Werk Green (primary action)
  '#0fa03d', // 7 — hover
  '#0c8038', // 8 — Deep Green (links, green text on light)
  '#0a6b2e', // 9
];

// Warm ink-green neutrals so grays relate to the green, not to a cold blue.
// slate.9 = Ink (#17211C), slate.1 = Shade (#F3F6F4), slate.0 = Paper (#FBFCFB).
const slate: MantineColorsTuple = [
  '#fbfcfb', // 0 — Paper (app background)
  '#f3f6f4', // 1 — Shade (panels)
  '#e6ebe8', // 2 — borders / dividers
  '#cbd4cf', // 3
  '#9ba8a1', // 4
  '#6e7c75', // 5 — muted labels
  '#4a554f', // 6 — body text (muted)
  '#333d38', // 7
  '#232e28', // 8
  '#17211c', // 9 — Ink (primary text)
];

// Outfit — friendly geometric sans for body & UI (very legible for older readers).
const uiFont =
  'var(--font-outfit), Outfit, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
// Space Grotesk — wordmark, headings, titles (tightened tracking).
const brandFont =
  'var(--font-space-grotesk), "Space Grotesk", var(--font-outfit), Outfit, system-ui, sans-serif';

export const theme = createTheme({
  primaryColor: 'brand',
  primaryShade: 6,
  colors: { brand, slate },
  defaultRadius: 'md',
  fontFamily: uiFont,
  fontFamilyMonospace: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  headings: { fontFamily: brandFont, fontWeight: '600' },
  // Cards 14–16px, buttons are pills (brand spec: --fw-radius-button: 999px).
  radius: { sm: '8px', md: '12px', lg: '16px', xl: '20px' },
  components: {
    Button: { defaultProps: { radius: 999 } },
  },
  black: '#17211c',
});
