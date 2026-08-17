import { describe, expect, it, vi } from 'vitest';
import type { PhotoBookPhotoRef, LoadedPhotoBook } from '@/lib/photo-book-content';
import type { PhotoBookPlan } from '@/lib/photo-book-plan';

/**
 * `lib/photo-book-ai-layout.ts` is otherwise a worker/AI-call module (OpenRouter, S3,
 * Postgres), but `applyPhotoPlanCarryOver` itself is a pure function over already-loaded
 * data — this test exercises just that function, mocking the two leaf modules
 * (`@/db`, `@/lib/env`) that would otherwise need a real database/credentials just to
 * import the file. Mirrors `lib/gelato.test.ts`'s `vi.mock('@/lib/env', …)` approach.
 */
vi.mock('@/db', () => ({ db: {} }));
vi.mock('@/lib/env', () => ({
  env: {
    OPENROUTER_API_KEY: 'test',
    OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
    BETTER_AUTH_URL: 'http://localhost:3000',
    STYLING_MODEL: 'test-model',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_REGION: 'auto',
    S3_BUCKET: 'test',
    S3_ACCESS_KEY_ID: 'test',
    S3_SECRET_ACCESS_KEY: 'test',
    S3_FORCE_PATH_STYLE: true,
  },
}));

const { applyPhotoPlanCarryOver } = await import('./photo-book-ai-layout');
const { planChapters } = await import('./photo-book-content');

function photo(overrides: Partial<PhotoBookPhotoRef> = {}): PhotoBookPhotoRef {
  return {
    assetId: 'a',
    s3Key: 'books/photos/a.jpg',
    thumbS3Key: null,
    displayS3Key: null,
    mimeType: 'image/jpeg',
    width: 800,
    height: 600,
    position: 0,
    storyId: null,
    excluded: false,
    excludedReason: null,
    userDecision: null,
    takenAt: null,
    gpsLat: null,
    gpsLng: null,
    phash: null,
    blurScore: null,
    analysis: null,
    ...overrides,
  };
}

function loaded(overrides: Partial<LoadedPhotoBook['row']> = {}, photos: PhotoBookPhotoRef[] = []): LoadedPhotoBook {
  return {
    chapters: [],
    row: {
      id: 'book-1',
      title: 'Familie Müller',
      subtitle: null,
      coverAssetId: null,
      layoutPlan: null,
      layoutStale: false,
      chronicleId: 'chronicle-1',
      ...overrides,
    } as LoadedPhotoBook['row'],
    photos,
  };
}

function aiPlan(overrides: Partial<PhotoBookPlan> = {}): PhotoBookPlan {
  return {
    kind: 'photo',
    style: 'modern',
    cover: {
      heroAssetId: 'a',
      title: 'A title the model made up',
      subtitle: 'A subtitle the model made up',
    },
    sections: [],
    ...overrides,
  };
}

describe('applyPhotoPlanCarryOver — cover title/subtitle (config wins over the AI)', () => {
  it("overrides the model's proposed title with the book's own title", () => {
    const result = applyPhotoPlanCarryOver(aiPlan(), loaded({ title: 'Familie Müller' }));
    expect(result.cover.title).toBe('Familie Müller');
  });

  it("overrides the model's proposed subtitle with the book's own subtitle", () => {
    const result = applyPhotoPlanCarryOver(
      aiPlan(),
      loaded({ title: 'Familie Müller', subtitle: 'Sommer 2025' }),
    );
    expect(result.cover.subtitle).toBe('Sommer 2025');
  });

  it("drops the model's subtitle entirely when the book has none set", () => {
    const result = applyPhotoPlanCarryOver(aiPlan(), loaded({ title: 'Familie Müller', subtitle: null }));
    expect(result.cover.subtitle).toBeUndefined();
    expect('subtitle' in result.cover).toBe(false);
  });

  it('still applies the pinned-cover-hero override alongside the title/subtitle override', () => {
    const photos = [photo({ assetId: 'pinned' }), photo({ assetId: 'a' })];
    const result = applyPhotoPlanCarryOver(
      aiPlan({ cover: { heroAssetId: 'a', title: 'x' } }),
      loaded({ title: 'Familie Müller', coverAssetId: 'pinned' }, photos),
    );
    expect(result.cover.heroAssetId).toBe('pinned');
    expect(result.cover.title).toBe('Familie Müller');
  });

  it("keeps the model's hero pick when there is no pin", () => {
    const result = applyPhotoPlanCarryOver(aiPlan({ cover: { heroAssetId: 'a', title: 'x' } }), loaded());
    expect(result.cover.heroAssetId).toBe('a');
  });

  it('carries the existing stored style forward over the model style', () => {
    const existingPlan: PhotoBookPlan = { kind: 'photo', style: 'heirloom', cover: { title: 'x' }, sections: [] };
    const result = applyPhotoPlanCarryOver(aiPlan({ style: 'bold' }), loaded({ layoutPlan: existingPlan }));
    expect(result.style).toBe('heirloom');
  });

  it('never lets an AI reply convert a standard book into the Birthday template', () => {
    const result = applyPhotoPlanCarryOver(
      aiPlan({
        template: 'birthday',
        cover: { title: 'x', heroAssetId: 'a', assetIds: ['a'] },
      }),
      loaded(),
    );
    expect(result.template).toBe('standard');
    expect(result.cover.assetIds).toBeUndefined();
  });

  it('carries an existing Birthday template and its cover selection through defensively', () => {
    const existingPlan: PhotoBookPlan = {
      kind: 'photo',
      template: 'birthday',
      style: 'classic',
      cover: { title: 'Birthday', heroAssetId: 'a', assetIds: ['a', 'b'] },
      sections: [],
    };
    const photos = [photo({ assetId: 'a' }), photo({ assetId: 'b' })];
    const result = applyPhotoPlanCarryOver(aiPlan(), loaded({ layoutPlan: existingPlan }, photos));
    expect(result.template).toBe('birthday');
    expect(result.cover.assetIds).toEqual(['a', 'b']);
  });

  it('trims a carried-over cover that predates the 4-photo grid', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const existingPlan: PhotoBookPlan = {
      kind: 'photo',
      template: 'birthday',
      style: 'classic',
      cover: { title: 'Birthday', heroAssetId: 'a', assetIds: ids },
      sections: [],
    };
    const photos = ids.map((assetId) => photo({ assetId }));
    const result = applyPhotoPlanCarryOver(aiPlan(), loaded({ layoutPlan: existingPlan }, photos));
    expect(result.cover.assetIds).toEqual(['a', 'b', 'c', 'd']);
    expect(result.cover.heroAssetId).toBe('a');
  });
});

describe('planChapters — only content-bearing chapters constrain a plan', () => {
  it('keeps photo-only/text chapters but drops an attached chapter with no printable content', () => {
    const book = loaded({}, [
      photo({ assetId: 'p1', storyId: 'photo-story' }),
      photo({ assetId: 'pending', storyId: 'pending-story', width: null, height: null }),
    ]);
    book.chapters = [
      {
        storyId: 'empty-story',
        title: 'Empty',
        eventLabel: null,
        eventDate: null,
        body: '',
        paragraphs: [],
        includeText: false,
        includePhotos: true,
        position: 0,
      },
      {
        storyId: 'photo-story',
        title: 'Photos',
        eventLabel: null,
        eventDate: null,
        body: '',
        paragraphs: [],
        includeText: false,
        includePhotos: true,
        position: 1,
      },
      {
        storyId: 'pending-story',
        title: 'Pending photo',
        eventLabel: null,
        eventDate: null,
        body: '',
        paragraphs: [],
        includeText: false,
        includePhotos: true,
        position: 2,
      },
      {
        storyId: 'text-story',
        title: 'Text',
        eventLabel: null,
        eventDate: null,
        body: 'One paragraph',
        paragraphs: ['One paragraph'],
        includeText: true,
        includePhotos: true,
        position: 3,
      },
    ];
    expect(planChapters(book)).toEqual([
      { storyId: 'photo-story', paragraphCount: 0, title: 'Photos' },
      { storyId: 'text-story', paragraphCount: 1, title: 'Text' },
    ]);
  });
});
