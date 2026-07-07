'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/session';
import { requireOwner, updateChronicle } from '@/lib/chronicles';
import { isLocale } from '@/lib/i18n/config';

/** Update a chronicle's name, description, writing-style guide, and story language. */
export async function saveChronicleSettings(input: {
  chronicleId: string;
  name: string;
  description: string;
  styleGuide: string;
  /** 'auto' = keep each submission's language. */
  storyLanguage: string;
}) {
  const user = await requireUser();
  await requireOwner(input.chronicleId, user.id);

  const name = input.name.trim();
  if (!name) {
    throw new Error('A chronicle name is required.');
  }

  await updateChronicle(input.chronicleId, {
    name,
    description: input.description.trim() || null,
    styleGuide: input.styleGuide.trim() || null,
    storyLanguage: isLocale(input.storyLanguage) ? input.storyLanguage : null,
  });

  revalidatePath('/settings');
  revalidatePath('/chronicle');
}
