import { describe, expect, it } from 'vitest';
import { bookEngineFor, isLegacyStoryPlan } from './book-plan-kind';

/** The fork that lets existing memoir books keep their exact look until their owner
 *  regenerates them — see the module comment for why it reads the plan, not a column. */
describe('bookEngineFor', () => {
  const legacyPlan = {
    theme: 'classic',
    cover: { style: 'framed', heroAssetId: 'a1' },
    chapters: [{ storyId: 's1', blocks: [{ type: 'paragraphs', from: 0, to: 3 }] }],
  };
  const unifiedPlan = {
    kind: 'photo',
    style: 'classic',
    cover: { title: 'Buch', heroAssetId: 'a1' },
    sections: [{ title: 'S', pages: [{ template: 'full-framed', assetIds: ['a1'] }] }],
  };

  it('routes a stored story-book plan to the legacy engine', () => {
    expect(bookEngineFor(legacyPlan)).toBe('legacy');
    expect(isLegacyStoryPlan(legacyPlan)).toBe(true);
  });

  it('routes a unified plan to the new engine', () => {
    expect(bookEngineFor(unifiedPlan)).toBe('unified');
    expect(isLegacyStoryPlan(unifiedPlan)).toBe(false);
  });

  it('routes a book with NO plan to the new engine (nothing to preserve)', () => {
    expect(bookEngineFor(null)).toBe('unified');
    expect(bookEngineFor(undefined)).toBe('unified');
  });

  it('routes an unrecognisable plan to the new engine rather than the retired one', () => {
    expect(bookEngineFor({ nonsense: true })).toBe('unified');
    expect(bookEngineFor('not a plan')).toBe('unified');
  });

  it('a unified plan carrying story chapters is still unified', () => {
    expect(
      bookEngineFor({
        ...unifiedPlan,
        sections: [{ title: 'Kapitel', storyId: 's1', pages: [{ template: 'text', from: 0, to: 2 }] }],
      }),
    ).toBe('unified');
  });
});

/** The property that makes the whole migration strategy safe: a real stored plan from a
 *  production story book must keep routing to the legacy engine, and a real photo-book
 *  plan must not. Uses the exact shapes both producers write. */
describe('routing stability against real producer output', () => {
  it('keeps a story plan with floats and figure sizes on the legacy engine', () => {
    const storyPlan = {
      theme: 'modern',
      cover: { style: 'full-bleed', heroAssetId: 'hero' },
      chapters: [
        {
          storyId: 's1',
          blocks: [
            { type: 'paragraphs', from: 0, to: 2 },
            { type: 'figure', assetId: 'a1', size: 'float-left' },
            { type: 'paragraphs', from: 3, to: 9 },
            { type: 'photo-page', assetId: 'a2' },
          ],
        },
      ],
    };
    expect(bookEngineFor(storyPlan)).toBe('legacy');
  });

  it('keeps a unified plan with every new template on the new engine', () => {
    const unified = {
      kind: 'photo',
      style: 'heirloom',
      cover: { title: 'Buch', heroAssetId: 'hero' },
      sections: [
        {
          title: 'Kapitel',
          storyId: 's1',
          pages: [
            { template: 'text', from: 0, to: 4 },
            { template: 'four-mixed', assetIds: ['a', 'b', 'c', 'd'] },
            { template: 'collage-6', assetIds: ['e', 'f', 'g', 'h', 'i', 'j'] },
          ],
        },
      ],
    };
    expect(bookEngineFor(unified)).toBe('unified');
  });
});
