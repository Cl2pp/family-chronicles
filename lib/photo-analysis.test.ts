import { describe, expect, it } from 'vitest';
import {
  extractJsonArray,
  parseStoredPhotoAnalysis,
  parseVisionBatchResponse,
  photoAnalysisSchema,
  splitIntoVisionBatches,
} from './photo-analysis';

const SAMPLE_ANALYSIS = {
  aestheticScore: 8.5,
  sharpness: 'sharp' as const,
  eyesClosed: false,
  peopleCount: 2,
  sceneTags: ['beach', 'family'],
  shortDescription: 'Two people smiling on a beach.',
  coverCandidate: true,
};

describe('splitIntoVisionBatches', () => {
  it('splits into fixed-size batches', () => {
    const ids = Array.from({ length: 23 }, (_, i) => `id${i}`);
    const batches = splitIntoVisionBatches(ids, 10);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(10);
    expect(batches[1]).toHaveLength(10);
    expect(batches[2]).toHaveLength(3);
  });

  it('preserves order and every id exactly once', () => {
    const ids = Array.from({ length: 17 }, (_, i) => `id${i}`);
    const batches = splitIntoVisionBatches(ids, 5);
    expect(batches.flat()).toEqual(ids);
  });

  it('returns no batches for an empty input', () => {
    expect(splitIntoVisionBatches([], 10)).toEqual([]);
  });

  it('defaults to the standard batch size', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `id${i}`);
    expect(splitIntoVisionBatches(ids)).toHaveLength(1);
    expect(splitIntoVisionBatches([...ids, 'extra'])).toHaveLength(2);
  });

  it('throws on a non-positive batch size', () => {
    expect(() => splitIntoVisionBatches(['a'], 0)).toThrow();
    expect(() => splitIntoVisionBatches(['a'], -1)).toThrow();
  });

  it('a single batch smaller than the batch size stays one batch', () => {
    expect(splitIntoVisionBatches(['a', 'b', 'c'], 10)).toEqual([['a', 'b', 'c']]);
  });
});

describe('extractJsonArray', () => {
  it('parses a bare JSON array', () => {
    expect(extractJsonArray('[1, 2, 3]')).toEqual([1, 2, 3]);
  });

  it('strips a ```json fence', () => {
    expect(extractJsonArray('```json\n[{"a":1}]\n```')).toEqual([{ a: 1 }]);
  });

  it('strips a bare ``` fence', () => {
    expect(extractJsonArray('```\n[{"a":1}]\n```')).toEqual([{ a: 1 }]);
  });

  it('tolerates leading/trailing prose', () => {
    expect(extractJsonArray('Sure, here it is:\n[1,2]\nHope that helps!')).toEqual([1, 2]);
  });

  it('returns null for a JSON object, not an array', () => {
    expect(extractJsonArray('{"a": 1}')).toBeNull();
  });

  it('returns null for unparseable text', () => {
    expect(extractJsonArray('not json at all')).toBeNull();
  });

  it('returns null for malformed JSON inside brackets', () => {
    expect(extractJsonArray('[{"a": 1,}]')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(extractJsonArray('')).toBeNull();
  });
});

describe('parseVisionBatchResponse', () => {
  it('parses a well-formed batch of valid items', () => {
    const raw = JSON.stringify([
      { assetId: 'a', ...SAMPLE_ANALYSIS },
      { assetId: 'b', ...SAMPLE_ANALYSIS, aestheticScore: 3, coverCandidate: false },
    ]);
    const result = parseVisionBatchResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.results.size).toBe(2);
    expect(result!.results.get('a')).toEqual(SAMPLE_ANALYSIS);
    expect(result!.results.get('b')?.aestheticScore).toBe(3);
    expect(result!.invalidIds).toEqual([]);
  });

  it('tolerates markdown fences around the array', () => {
    const raw = '```json\n' + JSON.stringify([{ assetId: 'a', ...SAMPLE_ANALYSIS }]) + '\n```';
    const result = parseVisionBatchResponse(raw);
    expect(result?.results.get('a')).toEqual(SAMPLE_ANALYSIS);
  });

  it('drops an item with a bad field but keeps the rest, reporting its id as invalid', () => {
    const raw = JSON.stringify([
      { assetId: 'good', ...SAMPLE_ANALYSIS },
      { assetId: 'bad', ...SAMPLE_ANALYSIS, aestheticScore: 'not a number' },
    ]);
    const result = parseVisionBatchResponse(raw);
    expect(result?.results.size).toBe(1);
    expect(result?.results.has('good')).toBe(true);
    expect(result?.invalidIds).toEqual(['bad']);
  });

  it('rejects an aestheticScore out of the 0-10 range', () => {
    const raw = JSON.stringify([{ assetId: 'x', ...SAMPLE_ANALYSIS, aestheticScore: 11 }]);
    const result = parseVisionBatchResponse(raw);
    expect(result?.results.size).toBe(0);
    expect(result?.invalidIds).toEqual(['x']);
  });

  it('rejects an item with no assetId and cannot report its id', () => {
    const raw = JSON.stringify([{ ...SAMPLE_ANALYSIS }]);
    const result = parseVisionBatchResponse(raw);
    expect(result?.results.size).toBe(0);
    expect(result?.invalidIds).toEqual([]);
  });

  it('an omitted photo simply never appears in results (caller diffs against the batch it sent)', () => {
    const raw = JSON.stringify([{ assetId: 'only-this-one', ...SAMPLE_ANALYSIS }]);
    const result = parseVisionBatchResponse(raw);
    expect(result?.results.has('only-this-one')).toBe(true);
    expect(result?.results.has('missing-one')).toBe(false);
  });

  it('returns null when there is no JSON array at all', () => {
    expect(parseVisionBatchResponse('I could not analyze these photos.')).toBeNull();
  });

  it('returns a non-null empty result for a well-formed but entirely-invalid array', () => {
    const raw = JSON.stringify([{ foo: 'bar' }]);
    const result = parseVisionBatchResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.results.size).toBe(0);
  });
});

describe('parseStoredPhotoAnalysis', () => {
  it('accepts a valid analysis object', () => {
    expect(parseStoredPhotoAnalysis(SAMPLE_ANALYSIS)).toEqual(SAMPLE_ANALYSIS);
  });

  it('returns null for null/undefined', () => {
    expect(parseStoredPhotoAnalysis(null)).toBeNull();
    expect(parseStoredPhotoAnalysis(undefined)).toBeNull();
  });

  it('returns null for a value that fails schema validation', () => {
    expect(parseStoredPhotoAnalysis({ ...SAMPLE_ANALYSIS, sharpness: 'ultra-crisp' })).toBeNull();
    expect(parseStoredPhotoAnalysis('not an object')).toBeNull();
    expect(parseStoredPhotoAnalysis({})).toBeNull();
  });
});

describe('photoAnalysisSchema', () => {
  it('accepts the full valid shape', () => {
    expect(photoAnalysisSchema.safeParse(SAMPLE_ANALYSIS).success).toBe(true);
  });

  it('rejects a negative peopleCount', () => {
    expect(photoAnalysisSchema.safeParse({ ...SAMPLE_ANALYSIS, peopleCount: -1 }).success).toBe(false);
  });

  it('rejects a non-boolean eyesClosed', () => {
    expect(photoAnalysisSchema.safeParse({ ...SAMPLE_ANALYSIS, eyesClosed: 'no' }).success).toBe(false);
  });
});
