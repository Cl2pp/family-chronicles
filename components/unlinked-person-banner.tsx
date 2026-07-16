'use client';

import { useState } from 'react';
import { Alert } from '@mantine/core';
import { IconUserQuestion } from '@tabler/icons-react';
import { useI18n } from '@/lib/i18n/client';

/**
 * Shown on the stories list when the user belongs to at least one 'family'-mode
 * chronicle but their account is linked to no person in the tree: under the
 * story-access rule (lib/story-access.ts) they only see their own submissions
 * until an owner places them in the family tree. Dismissable per render — it
 * comes back on the next visit, like the verify-email nudge.
 */
export function UnlinkedPersonBanner() {
  const { t } = useI18n();
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;
  return (
    <Alert
      icon={<IconUserQuestion size={18} />}
      title={t.stories.unlinkedTitle}
      color="yellow"
      mb="md"
      withCloseButton
      closeButtonLabel={t.stories.unlinkedDismiss}
      onClose={() => setDismissed(true)}
    >
      {t.stories.unlinkedBody}
    </Alert>
  );
}
