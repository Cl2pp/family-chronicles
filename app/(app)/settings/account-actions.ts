'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { people } from '@/db/schema';
import { auth } from '@/lib/auth';
import { requireUser } from '@/lib/session';
import { buildKey, deleteObject, presignPut } from '@/lib/s3';
import { validateUpload } from '@/lib/uploads';

/** A presigned URL the browser uses to PUT a new avatar straight to storage. */
export async function presignAvatarUpload(input: {
  mimeType: string;
  bytes: number;
}): Promise<{ url: string; s3Key: string; mimeType: string }> {
  await requireUser();
  const upload = validateUpload('avatar', input.mimeType, input.bytes);
  const s3Key = buildKey('avatars', upload.ext);
  const url = await presignPut(s3Key, upload.mimeType, upload.bytes);
  return { url, s3Key, mimeType: upload.mimeType };
}

/** Point the account (and its linked person, if any) at an uploaded avatar. */
export async function saveAvatar(input: { s3Key: string }): Promise<void> {
  const user = await requireUser();
  if (!input.s3Key.startsWith('avatars/')) {
    throw new Error('Invalid avatar upload.');
  }
  const oldKey = user.image ?? null;

  await auth.api.updateUser({
    headers: await headers(),
    body: { image: input.s3Key },
  });
  await db
    .update(people)
    .set({ avatarS3Key: input.s3Key, updatedAt: new Date() })
    .where(eq(people.userId, user.id));

  if (oldKey && oldKey.startsWith('avatars/') && oldKey !== input.s3Key) {
    try {
      await deleteObject(oldKey);
    } catch {
      // Best-effort cleanup — a stale object is harmless.
    }
  }

  revalidatePath('/', 'layout');
}

/** Rename the account. Tree names are edited separately on the Chronicle tab. */
export async function updateDisplayName(input: { name: string }): Promise<void> {
  await requireUser();
  const name = input.name.trim();
  if (!name) throw new Error('A name is required.');

  await auth.api.updateUser({ headers: await headers(), body: { name } });
  revalidatePath('/', 'layout');
}
