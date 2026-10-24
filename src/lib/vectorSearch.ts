/**
 * Nearest-neighbour search over the user's own report library, by brute force.
 *
 * Milestone 3 of `docs/proposals/rag.md`. It is deliberately about forty lines of
 * arithmetic and no dependency, which is the whole argument of that proposal made
 * concrete.
 *
 * ## Why there is no vector database here
 *
 * Run the numbers before reaching for one. A library of 500 chunks at 768
 * dimensions is 384,000 floats — about 1.5 MB held as `Float32Array`, and a full
 * scan is 384,000 multiply-adds. That is sub-millisecond, once, on a refine action
 * the user deliberately clicked.
 *
 * An approximate-nearest-neighbour index exists to avoid scanning *millions* of
 * vectors. At this scale it is slower to load than the scan it replaces, and it
 * costs two things this project cannot spend casually: bundle budget, which
 * `npm run check:size` gates and which has around 330 kB of headroom in total, and
 * `'wasm-unsafe-eval'` in `script-src`, which is a change to the security posture
 * documented in `src/server/securityHeaders.ts`.
 *
 * **If the corpus ever genuinely is large, replace this file and nothing else.**
 * Everything either side of it speaks in vectors and scores.
 *
 * ## Two failure modes worth knowing about
 *
 * **Comparing vectors from different embedding models returns confident nonsense.**
 * Cosine similarity between two spaces is a number, it is in range, and it means
 * nothing at all. Nothing downstream can detect it. So a dimension mismatch throws
 * here rather than scoring — it can only be a bug (the store records which model
 * produced each vector for exactly this reason), and a loud failure on a refine
 * action is far cheaper than silently retrieving the wrong five examples forever.
 *
 * **A zero-magnitude vector scores 0, not `NaN`.** Dividing by a zero norm is the
 * one arithmetic edge here, and `NaN` sorts unpredictably rather than losing: it
 * would neither rank nor be filtered out by a `minScore`, so it can surface at the
 * top of the results. An all-zero vector is meaningless input, and 0 is the honest
 * score for it.
 */

/** Either representation; `Float32Array` is what the store keeps, arrays are what JSON gives back. */
export type Vector = readonly number[] | Float32Array;

/** One candidate: whatever the caller is searching over, and its embedding. */
export interface Embedded<T> {
  item: T;
  vector: Vector;
}

/** One result, with the score that put it there. */
export interface Match<T> {
  item: T;
  /** Cosine similarity, -1 to 1. Higher is closer. */
  score: number;
}

export interface SearchOptions<T> {
  /** How many to return. Defaults to 5; anything below 1 returns nothing. */
  k?: number;
  /** Drop anything scoring below this. Unset keeps everything that survives `where`. */
  minScore?: number;
  /** Narrow the candidates before scoring — by source file, by band, by control type. */
  where?: (item: T) => boolean;
}

const DEFAULT_K = 5;

/**
 * Cosine similarity between two vectors.
 *
 * Computed in full rather than as a bare dot product: a dot product is only the
 * cosine when both vectors are unit length, and while embedding APIs generally
 * return normalized vectors, "generally" is not a property to build ranking on.
 * The extra work is two more multiply-adds per dimension.
 *
 * @throws if the two vectors are different lengths — see the header.
 */
export function cosine(a: Vector, b: Vector): number {
  if (a.length !== b.length) {
    throw new Error(
      `cosine: dimension mismatch, ${a.length} against ${b.length}. ` +
        'Vectors from two embedding models are not comparable; re-embed the library.',
    );
  }

  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }

  if (aa === 0 || bb === 0) return 0;
  return dot / Math.sqrt(aa * bb);
}

/**
 * The closest candidates to `query`, best first.
 *
 * Ties keep the order they were given, which makes a result reproducible for the
 * same library — two chunks with identical captions are otherwise returned in an
 * order that depends on the sort implementation, and a retrieval that reorders
 * itself between runs is one nobody can debug.
 *
 * `where` runs before scoring, so a narrow filter is also the cheap path.
 */
export function topMatches<T>(
  query: Vector,
  candidates: readonly Embedded<T>[],
  options: SearchOptions<T> = {},
): Match<T>[] {
  const k = options.k ?? DEFAULT_K;
  if (k < 1 || candidates.length === 0) return [];

  const scored: { match: Match<T>; at: number }[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (options.where && !options.where(candidate.item)) continue;

    const score = cosine(query, candidate.vector);
    if (options.minScore !== undefined && score < options.minScore) continue;

    scored.push({ match: { item: candidate.item, score }, at: i });
  }

  scored.sort((x, y) => (y.match.score - x.match.score) || (x.at - y.at));
  return scored.slice(0, k).map((s) => s.match);
}
