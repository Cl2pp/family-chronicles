import { Stack, Title, Text } from '@mantine/core';

/**
 * Shared typographic building blocks for the legal pages (Impressum,
 * Datenschutz). Server components — plain presentational markup, no state.
 */
export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Stack gap={8}>
      <Title order={2} fz={{ base: 'lg', sm: 'xl' }} c="slate.9">
        {title}
      </Title>
      {children}
    </Stack>
  );
}

export function P({ children }: { children: React.ReactNode }) {
  return (
    <Text c="slate.7" fz="sm" lh={1.75}>
      {children}
    </Text>
  );
}

export function Bullets({ items }: { items: React.ReactNode[] }) {
  return (
    <Text
      component="ul"
      c="slate.7"
      fz="sm"
      lh={1.7}
      style={{ margin: 0, paddingLeft: '1.25rem' }}
    >
      {items.map((item, i) => (
        <li key={i} style={{ marginBottom: 4 }}>
          {item}
        </li>
      ))}
    </Text>
  );
}
