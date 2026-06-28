'use client';

import { useEffect, useMemo } from 'react';
import { ActionIcon, Box, Group, Image, SimpleGrid, Text } from '@mantine/core';
import { Dropzone, IMAGE_MIME_TYPE } from '@mantine/dropzone';
import { IconPhoto, IconUpload, IconX } from '@tabler/icons-react';

export function PhotoUploader({
  files,
  onChange,
  max = 20,
}: {
  files: File[];
  onChange: (files: File[]) => void;
  max?: number;
}) {
  const urls = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);

  // Revoke object URLs when they change or the component unmounts.
  useEffect(() => {
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [urls]);

  function add(accepted: File[]) {
    onChange([...files, ...accepted].slice(0, max));
  }
  function remove(index: number) {
    onChange(files.filter((_, i) => i !== index));
  }

  return (
    <div>
      <Dropzone
        onDrop={add}
        accept={IMAGE_MIME_TYPE}
        maxSize={15 * 1024 * 1024}
        disabled={files.length >= max}
      >
        <Group justify="center" gap="sm" mih={80} style={{ pointerEvents: 'none' }}>
          <Dropzone.Accept>
            <IconUpload size={28} />
          </Dropzone.Accept>
          <Dropzone.Reject>
            <IconX size={28} />
          </Dropzone.Reject>
          <Dropzone.Idle>
            <IconPhoto size={28} />
          </Dropzone.Idle>
          <Text c="dimmed" size="sm">
            Drop photos here or click to choose
          </Text>
        </Group>
      </Dropzone>

      {files.length > 0 && (
        <SimpleGrid cols={{ base: 3, sm: 4 }} mt="sm" spacing="xs">
          {urls.map((u, i) => (
            <Box key={u} pos="relative">
              <Image src={u} radius="sm" h={90} fit="cover" alt="" />
              <ActionIcon
                size="sm"
                color="dark"
                variant="filled"
                pos="absolute"
                top={4}
                right={4}
                onClick={() => remove(i)}
                aria-label="Remove photo"
              >
                <IconX size={14} />
              </ActionIcon>
            </Box>
          ))}
        </SimpleGrid>
      )}
    </div>
  );
}
