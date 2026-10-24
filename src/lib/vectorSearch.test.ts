/**
 * The cases that matter are the two that return a plausible number instead of an
 * error: a dimension mismatch (two embedding models compared, which is meaningless
 * and in range) and a zero-magnitude vector (`NaN`, which neither ranks nor
 * filters and so surfaces at the top).
 *
 * The ordering cases matter for a different reason — a retrieval that reorders
 * itself between runs on the same library is one nobody can debug.
 *
 * As elsewhere in this suite the loops sit inside a single case, so the grep and the
 * run agree.
 */
import { describe, it, expect } from 'vitest';
import { cosine, topMatches, type Embedded } from './vectorSearch';

/** Candidates whose vectors are trivially rankable against [1, 0]. */
const named = (name: string, vector: number[]): Embedded<string> => ({ item: name, vector });

describe('cosine', () => {
  it('scores an identical direction 1 and an opposite one -1', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it('scores a right angle 0', () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([0, 3], [4, 0])).toBeCloseTo(0);
  });

  it('ignores magnitude, which is the property that makes it usable at all', () => {
    // A long document and a short one about the same thing must score the same.
    expect(cosine([1, 1], [50, 50])).toBeCloseTo(1);
    expect(cosine([2, 0], [0.001, 0])).toBeCloseTo(1);
  });

  it('accepts a Float32Array on either side, because that is what the store keeps', () => {
    expect(cosine(new Float32Array([1, 0]), [1, 0])).toBeCloseTo(1);
    expect(cosine([0, 1], new Float32Array([0, 1]))).toBeCloseTo(1);
    expect(cosine(new Float32Array([1, 2, 3]), new Float32Array([1, 2, 3]))).toBeCloseTo(1);
  });

  it('scores a zero vector 0 rather than NaN', () => {
    // NaN would neither rank nor be dropped by minScore, so it reaches the top.
    for (const pair of [[[0, 0], [1, 1]], [[1, 1], [0, 0]], [[0, 0], [0, 0]]]) {
      const score = cosine(pair[0], pair[1]);
      expect(Number.isNaN(score), JSON.stringify(pair)).toBe(false);
      expect(score).toBe(0);
    }
  });

  it('throws on a dimension mismatch instead of scoring two different spaces', () => {
    expect(() => cosine([1, 0], [1, 0, 0])).toThrow(/dimension mismatch/);
    expect(() => cosine([1, 0], [1, 0, 0])).toThrow(/re-embed/);
  });
});

describe('topMatches', () => {
  const library: Embedded<string>[] = [
    named('same', [1, 0]),
    named('right angle', [0, 1]),
    named('near', [0.9, 0.1]),
    named('opposite', [-1, 0]),
  ];

  it('returns the closest first', () => {
    const hits = topMatches([1, 0], library, { k: 2 });
    expect(hits.map((h) => h.item)).toEqual(['same', 'near']);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it('defaults to five and never returns more than it has', () => {
    expect(topMatches([1, 0], library)).toHaveLength(4);
    expect(topMatches([1, 0], library, { k: 99 })).toHaveLength(4);
  });

  it('returns nothing for an empty library or a k below one', () => {
    expect(topMatches([1, 0], [])).toEqual([]);
    for (const k of [0, -1]) {
      expect(topMatches([1, 0], library, { k }), String(k)).toEqual([]);
    }
  });

  it('drops anything below minScore', () => {
    const hits = topMatches([1, 0], library, { k: 10, minScore: 0.5 });
    expect(hits.map((h) => h.item)).toEqual(['same', 'near']);
  });

  it('filters before scoring, so a narrow where is also the cheap path', () => {
    let scored = 0;
    const counted = library.map((c) => ({ ...c, item: c.item }));
    const hits = topMatches([1, 0], counted, {
      k: 10,
      where: (item) => {
        scored++;
        return item !== 'opposite';
      },
    });
    expect(hits.map((h) => h.item)).not.toContain('opposite');
    expect(scored).toBe(library.length);
  });

  it('keeps the given order for ties, so the same library answers the same way twice', () => {
    const tied: Embedded<string>[] = [named('first', [1, 0]), named('second', [1, 0]), named('third', [2, 0])];
    // All three point the same way, so every score is 1 and only order separates them.
    expect(topMatches([1, 0], tied, { k: 3 }).map((h) => h.item)).toEqual(['first', 'second', 'third']);
    expect(topMatches([1, 0], tied, { k: 2 }).map((h) => h.item)).toEqual(['first', 'second']);
  });

  it('propagates a dimension mismatch rather than skipping the candidate', () => {
    // Silently skipping would return a shorter, plausible result set from a library
    // that is half in the wrong space.
    const mixed: Embedded<string>[] = [named('ok', [1, 0]), named('other model', [1, 0, 0])];
    expect(() => topMatches([1, 0], mixed, { k: 2 })).toThrow(/dimension mismatch/);
  });

  it('carries the score back, because a caller may want to refuse a weak match', () => {
    const [hit] = topMatches([1, 0], [named('same', [1, 0])], { k: 1 });
    expect(hit.score).toBeCloseTo(1);
    expect(hit.item).toBe('same');
  });
});
