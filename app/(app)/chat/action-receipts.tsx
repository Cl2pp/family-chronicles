'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Anchor, Button, Stack, Text, ThemeIcon } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowBackUp, IconCheck } from '@tabler/icons-react';
import { useI18n } from '@/lib/i18n/client';
import type { Receipt } from '@/lib/ai/tools';
import { undoAction } from './actions';

/** The ✓ "did X" chips shown under an assistant reply for actions applied this turn. */
export function ActionReceipts({ receipts }: { receipts: Receipt[] }) {
  const { t } = useI18n();
  const [undone, setUndone] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<number | null>(null);

  async function undo(index: number, receipt: Receipt) {
    if (!receipt.undo) return;
    setBusy(index);
    try {
      const res = await undoAction(receipt.undo);
      if (res.ok) {
        setUndone((s) => new Set(s).add(index));
      } else {
        notifications.show({ color: 'red', message: res.error });
      }
    } catch {
      notifications.show({ color: 'red', message: t.chat.couldNotUndo });
    } finally {
      setBusy(null);
    }
  }

  if (receipts.length === 0) return null;
  return (
    <Stack gap={6}>
      {receipts.map((r, i) => {
        const isUndone = undone.has(i);
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <ThemeIcon color={isUndone ? 'gray' : 'green'} variant="light" radius="xl" size={20} mt={1}>
              <IconCheck size={13} />
            </ThemeIcon>
            <div style={{ flex: 1 }}>
              <Text size="sm" fw={500} td={isUndone ? 'line-through' : undefined} c={isUndone ? 'dimmed' : undefined}>
                {r.label}
              </Text>
              {r.detail &&
                (r.href ? (
                  <Anchor component={Link} href={r.href} size="xs" c="dimmed">
                    {r.detail}
                  </Anchor>
                ) : (
                  <Text size="xs" c="dimmed" style={{ wordBreak: 'break-all' }}>
                    {r.detail}
                  </Text>
                ))}
            </div>
            {r.undo &&
              (isUndone ? (
                <Text size="xs" c="dimmed" mt={2}>
                  {t.common.undone}
                </Text>
              ) : (
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color="gray"
                  leftSection={<IconArrowBackUp size={13} />}
                  loading={busy === i}
                  onClick={() => undo(i, r)}
                >
                  {t.common.undo}
                </Button>
              ))}
          </div>
        );
      })}
    </Stack>
  );
}
