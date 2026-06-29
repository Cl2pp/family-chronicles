import { Badge, Box, Stack, Text, Title } from '@mantine/core';

/**
 * Placeholder for redesigned routes whose full build lands in a later phase.
 * Keeps the new app shell navigable while phases roll out.
 */
export function PageStub({
  title,
  phase,
  children,
}: {
  title: string;
  phase: string;
  children?: React.ReactNode;
}) {
  return (
    <Box p="lg" maw={960} mx="auto">
      <Stack gap="xs">
        <Title order={2} fz={24}>
          {title}
        </Title>
        <Badge variant="light" color="brand" w="fit-content">
          {phase}
        </Badge>
        {children ? (
          <Box mt="sm">{children}</Box>
        ) : (
          <Text c="dimmed" mt="sm">
            This screen is part of the redesign and will be built in an upcoming phase.
          </Text>
        )}
      </Stack>
    </Box>
  );
}
