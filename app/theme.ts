'use client';

import { createTheme, type MantineColorsTuple } from '@mantine/core';

// Warm terracotta — approachable, memoir-like, easy on the eyes in light mode.
const sienna: MantineColorsTuple = [
  '#fdf5ef',
  '#f3e6da',
  '#e7c9b3',
  '#dbac89',
  '#d1936b',
  '#cb8458',
  '#c97c4e',
  '#b16a3f',
  '#9e5e36',
  '#8a4f2b',
];

export const theme = createTheme({
  primaryColor: 'sienna',
  primaryShade: 6,
  colors: { sienna },
  defaultRadius: 'md',
  fontFamily:
    'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  // Serif headings give the family-book feel; generous, readable sizes.
  headings: {
    fontFamily: 'Georgia, "Iowan Old Style", "Times New Roman", serif',
    fontWeight: '600',
  },
});
