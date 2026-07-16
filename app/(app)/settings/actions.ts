'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/session';
import {
  normalizeStoryLanguage,
  requireOwner,
  updateChronicle,
  type StoryAccessMode,
} from '@/lib/chronicles';
import type { Locale } from '@/lib/i18n/config';

/** Update a chronicle's name, description, writing-style guide, story language, and story access. */
export async function saveChronicleSettings(input: {
  chronicleId: string;
  name: string;
  description: string;
  styleGuide: string;
  /** 'auto' = keep each submission's language. */
  storyLanguage: Locale | 'auto';
  /** 'open' = every member reads everything; 'family' = kinship-gated reads. */
  storyAccess: StoryAccessMode;
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
    storyLanguage: normalizeStoryLanguage(input.storyLanguage),
    // Never trust the client string beyond the two known modes.
    storyAccess: input.storyAccess === 'family' ? 'family' : 'open',
  });

  revalidatePath('/settings');
  revalidatePath('/chronicle');
}
