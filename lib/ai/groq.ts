import Groq from 'groq-sdk';
import { env } from '@/lib/env';

/** Groq hosts Whisper for fast, cheap, multilingual transcription. */
const client = new Groq({ apiKey: env.GROQ_API_KEY, baseURL: env.GROQ_BASE_URL });

/**
 * Transcribe an audio buffer with Groq Whisper.
 * Whisper auto-detects the spoken language and returns plain text.
 */
export async function transcribeAudio(
  buffer: Buffer,
  filename: string,
  mimeType: string,
): Promise<string> {
  // Node 20+ provides a global File; the SDK accepts it directly.
  const file = new File([new Uint8Array(buffer)], filename, { type: mimeType });

  const result = await client.audio.transcriptions.create({
    file,
    model: env.TRANSCRIBE_MODEL,
    response_format: 'text',
  });

  // With response_format: 'text' the SDK returns the raw string.
  const text = typeof result === 'string' ? result : (result as { text?: string }).text ?? '';
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Transcription returned empty text');
  return trimmed;
}
