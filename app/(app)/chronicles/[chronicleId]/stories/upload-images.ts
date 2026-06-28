'use client';

import type { PhotoInput } from '@/lib/stories';
import { createUploadUrlAction } from './actions';

async function readImageSize(file: File): Promise<{ width?: number; height?: number }> {
  try {
    const bmp = await createImageBitmap(file);
    const dims = { width: bmp.width, height: bmp.height };
    bmp.close?.();
    return dims;
  } catch {
    return {};
  }
}

/** Upload image files to storage via presigned URLs; returns asset metadata. */
export async function uploadImages(chronicleId: string, files: File[]): Promise<PhotoInput[]> {
  const out: PhotoInput[] = [];
  for (const file of files) {
    const contentType = file.type || 'image/jpeg';
    const { key, url } = await createUploadUrlAction({
      chronicleId,
      kind: 'photo',
      contentType,
      filename: file.name || 'photo.jpg',
    });
    const put = await fetch(url, {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': contentType },
    });
    if (!put.ok) throw new Error('Photo upload failed');

    const dims = await readImageSize(file);
    out.push({
      s3Key: key,
      mimeType: contentType,
      bytes: file.size,
      width: dims.width,
      height: dims.height,
    });
  }
  return out;
}
