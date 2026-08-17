import { describe, expect, it } from 'vitest';
import { bestPhotoPageForGroup, photoBookContentBox, photoPageAreaRatio } from './photo-book-fit';

const portrait = (assetId: string) => ({ assetId, width: 3000, height: 4000 });
const landscape = (assetId: string) => ({ assetId, width: 4000, height: 3000 });
const square = (assetId: string) => ({ assetId, width: 3000, height: 3000 });

describe('bestPhotoPageForGroup', () => {
  it('frames a landscape single on a portrait page instead of cropping half its width', () => {
    expect(bestPhotoPageForGroup([landscape('a')]).template).toBe('full-framed');
  });

  it('allows a shape-compatible portrait single to fill the page', () => {
    expect(bestPhotoPageForGroup([portrait('a')]).template).toBe('full-bleed');
  });

  it('stacks a mixed pair and keeps two portraits side by side', () => {
    expect(bestPhotoPageForGroup([landscape('a'), portrait('b')]).template).toBe('two-horizontal');
    expect(bestPhotoPageForGroup([portrait('a'), portrait('b')]).template).toBe('two-vertical');
  });

  it('uses a balanced mixed stack for three portraits instead of a thin single row', () => {
    const photos = [portrait('a'), portrait('b'), portrait('c')];
    const fitted = bestPhotoPageForGroup(photos);
    const thin = photoPageAreaRatio('three-column', photos, photoBookContentBox());
    expect(fitted.template).toBe('three-mixed');
    expect(fitted.areaRatio - thin).toBeGreaterThan(0.3);
  });

  it('subtracts fixed caption slots from the measured photo area', () => {
    const photos = [portrait('a'), portrait('b')];
    const box = photoBookContentBox();
    const withoutCaptions = photoPageAreaRatio('two-horizontal', photos, box);
    const withCaptions = photoPageAreaRatio(
      'two-horizontal',
      photos.map((photo) => ({ ...photo, captioned: true })),
      box,
    );

    expect(withCaptions).toBeLessThan(withoutCaptions - 0.05);
    expect(bestPhotoPageForGroup(photos.map((photo) => ({ ...photo, captioned: true }))).template).toBe(
      'two-vertical',
    );
  });

  it('ignores stored captions for collage templates that do not render them', () => {
    const photos = [portrait('a'), portrait('b'), portrait('c'), portrait('d')];
    const box = photoBookContentBox();

    expect(
      photoPageAreaRatio(
        'collage-4',
        photos.map((photo) => ({ ...photo, captioned: true })),
        box,
      ),
    ).toBeCloseTo(photoPageAreaRatio('collage-4', photos, box));
  });

  it('reorders a five-photo collage to maximize justified-row coverage', () => {
    const photos = [landscape('a'), landscape('b'), portrait('c'), portrait('d'), square('e')];
    const fitted = bestPhotoPageForGroup(photos);
    expect(fitted.template).toBe('collage-5');
    expect(fitted.ordered.map((p) => p.assetId).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(fitted.areaRatio).toBeGreaterThan(0.6);
  });
});
