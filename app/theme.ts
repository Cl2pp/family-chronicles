'use client';

import { createTheme, type MantineColorsTuple } from '@mantine/core';

// Modern brand blue (#2563EB family) — confident, app-like, light-mode only.
const brand: MantineColorsTuple = [
  '#eff4ff',
  '#dbe6fe',
  '#bfd3fe',
  '#93b4fd',
  '#609afa',
  '#3b82f6',
  '#2563eb',
  '#1d4ed8',
  '#1e40af',
  '#1e3a8a',
];

// Cool slate neutrals so grays relate to the blue.
const slate: MantineColorsTuple = [
  '#f8fafc',
  '#f1f5f9',
  '#e2e8f0',
  '#cbd5e1',
  '#94a3b8',
  '#64748b',
  '#475569',
  '#334155',
  '#1e293b',
  '#0f172a',
];

const fontStack =
  'var(--font-inter), Inter, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

export const theme = createTheme({
  primaryColor: 'brand',
  primaryShade: 6,
  colors: { brand, slate },
  defaultRadius: 'md',
  // Fully modern sans — UI and reading view alike (no serif).
  fontFamily: fontStack,
  fontFamilyMonospace: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  headings: { fontFamily: fontStack, fontWeight: '600' },
  radius: { sm: '8px', md: '12px', lg: '16px' },
  black: '#0f172a',
});
