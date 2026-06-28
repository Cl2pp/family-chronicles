'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/session';
import { createChronicle } from '@/lib/chronicles';

const schema = z.object({
  name: z.string().min(1, 'Name is required').max(120),
  description: z.string().max(2000).optional(),
});

export async function createChronicleAction(input: { name: string; description?: string }) {
  const user = await requireUser();
  const parsed = schema.parse(input);
  const created = await createChronicle({
    name: parsed.name.trim(),
    description: parsed.description?.trim() || null,
    userId: user.id,
  });
  revalidatePath('/dashboard');
  redirect(`/chronicles/${created.id}`);
}
