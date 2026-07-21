import { describe, expect, it } from 'vitest';
import {
  designStageIndex,
  isDesignInFlight,
  parseDesignStage,
  PHOTO_BOOK_DESIGN_STAGES,
} from '@/lib/photo-book-design-stage';

describe('parseDesignStage', () => {
  it('accepts every known stage and rejects anything else', () => {
    for (const stage of PHOTO_BOOK_DESIGN_STAGES) expect(parseDesignStage(stage)).toBe(stage);
    expect(parseDesignStage('rendering')).toBeNull();
    expect(parseDesignStage(null)).toBeNull();
    expect(parseDesignStage(3)).toBeNull();
  });
});

describe('designStageIndex', () => {
  it('reports -1 for no stage so the UI shows the first step as running', () => {
    expect(designStageIndex(null)).toBe(-1);
    expect(designStageIndex('preparing')).toBe(0);
    expect(designStageIndex('finalizing')).toBe(PHOTO_BOOK_DESIGN_STAGES.length - 1);
  });
});

describe('isDesignInFlight', () => {
  const now = new Date('2026-07-21T12:00:00Z');

  it('is false when no pass was ever requested', () => {
    expect(isDesignInFlight(null, now)).toBe(false);
  });

  it('is true for a pass that started recently', () => {
    expect(isDesignInFlight(new Date('2026-07-21T11:56:00Z'), now)).toBe(true);
  });

  it('gives up on a pass whose worker evidently died', () => {
    expect(isDesignInFlight(new Date('2026-07-21T11:30:00Z'), now)).toBe(false);
  });
});
