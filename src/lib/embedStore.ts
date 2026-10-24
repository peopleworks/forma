/**
 * The user's own report library: what is in it, what still needs embedding, and
 * what is safe to search.
 *
 * Milestone 2 of `docs/proposals/rag.md`. Everything here is a pure function over
 * a list — persistence is a two-method interface at the bottom of this file and no
 * implementation, which is deliberate and explained under *Storage* below.
 *
 * ## Identity is the content, not the file
 *
 * A chunk's id is a hash of its redacted XML. Three things follow, and all three
 * are the point rather than side effects:
 *
 * - **Re-importing an unchanged file costs nothing.** Embedding is a network call
 *   against the user's own quota; importing the same forty reports twice must not
 *   pay for it twice.
 * - **The same fragment in two files is one entry.** If a page footer is copied
 *   across thirty reports — which is exactly what a house style *is* — it should
 *   be one example that the search can return, not thirty identical hits filling
 *   every slot. The first one seen keeps its `source`.
 * - **Editing a report re-chunks it.** A changed fragment hashes differently, so it
 *   arrives as a new entry rather than silently keeping a vector describing the old
 *   text. Vectors going stale against their content is the failure that has no
 *   symptom: retrieval simply gets quietly worse.
 *
 * ## The model is recorded on every vector, and that is load-bearing
 *
 * `vectorSearch.ts` throws on a dimension mismatch because comparing two embedding
 * spaces produces a number that is in range and means nothing. That is the last
 * line of defence, not the first: `searchable()` here is what makes the mismatch
 * impossible by construction, by returning only entries embedded with the model
 * being searched. Change the embedding model and the library does not break — it
 * reports every entry as needing embedding again, which is the truth.
 *
 * ## Storage: an interface, and no implementation yet
 *
 * `LibraryStorage` is two methods over the whole corpus. That is the right shape at
 * this size — a few hundred entries is one read at startup and one write per import
 * — and it is wrong the moment the corpus is large enough that rewriting it all to
 * add one entry hurts. The arithmetic for when: 500 chunks at 768 dimensions is
 * about 1.5 MB as binary, but **as JSON it is nearer 3-4 MB**, because a float
 * serialises to ~8 characters.
 *
 * That number is why no adapter is written here. This project has never used
 * IndexedDB — every store in `src/lib` is `localStorage` or Firestore — and 3-4 MB
 * does not fit the ~5 MB `localStorage` gives an origin for everything it keeps,
 * including what the rest of the app already puts there. So the choice is
 * IndexedDB, or a hard cap on library size, or vectors quantised to something
 * smaller than JSON floats. **That is a decision for the owner and not a detail to
 * settle in passing**, so the seam is here and the binding is not.
 */
import type { RepxChunk } from './repxChunks';
import type { Embedded, Vector } from './vectorSearch';

/** One chunk in the library, embedded or waiting to be. */
export interface LibraryEntry {
  /** Hash of the chunk's XML. Stable across imports; see the header. */
  id: string;
  chunk: RepxChunk;
  /**
   * The embedding, or `null` while the chunk is known but not yet embedded.
   *
   * Nullable because chunking is local and instant while embedding is a batched
   * network call: a fifty-report import should land in the library immediately and
   * fill in its vectors afterwards, rather than being all-or-nothing on a request
   * that can fail halfway.
   *
   * `Vector` rather than `number[]` because IndexedDB persists a `Float32Array`
   * natively through structured clone — 4 bytes a dimension, against the ~13
   * characters JSON spends on one float. The embedding API answers in `number[]`
   * and the store keeps whichever it was given; `vectorSearch` reads both.
   */
  vector: Vector | null;
  /** Which embedding model produced `vector`. Empty while it has none. */
  model: string;
  /** When it first entered the library, epoch ms. */
  addedAt: number;
}

export interface MergeResult {
  entries: LibraryEntry[];
  /** How many chunks were new. */
  added: number;
  /** How many were already present, by content. */
  skipped: number;
}

/**
 * A 64-bit FNV-1a, as two 32-bit passes with different offset bases.
 *
 * Not `crypto.subtle`: that is async, which would make every caller here async for
 * a job that is de-duplication rather than security. Nothing about this needs to
 * resist an adversary — a user hashing their own reports has no reason to forge a
 * collision, and the cost of one is a single fragment not added.
 *
 * Two passes rather than one because 32 bits is not enough for comfort. Birthday
 * collisions at 32 bits start to matter in the tens of thousands of items, which a
 * large library could plausibly reach; at 64 they cannot be reached by anything
 * this feature will ever hold.
 */
export function contentId(xml: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < xml.length; i++) {
    const c = xml.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/**
 * Add chunks to a library, skipping anything already there by content.
 *
 * Returns a new array; the input is not mutated. Order is existing entries first,
 * then new ones in the order given, so the library reads as an import history.
 */
export function addChunks(
  existing: readonly LibraryEntry[],
  chunks: readonly RepxChunk[],
  now: number = Date.now(),
): MergeResult {
  const byId = new Set(existing.map((e) => e.id));
  const entries = existing.slice();
  let added = 0;
  let skipped = 0;

  for (const chunk of chunks) {
    const id = contentId(chunk.xml);
    if (byId.has(id)) {
      skipped++;
      continue;
    }
    byId.add(id);
    entries.push({ id, chunk, vector: null, model: '', addedAt: now });
    added++;
  }

  return { entries, added, skipped };
}

/**
 * The entries that need an embedding request for this model.
 *
 * Anything with no vector, and anything whose vector came from a different model.
 * The second half is what makes changing model a re-embed rather than a corruption
 * — see the header.
 */
export function entriesToEmbed(entries: readonly LibraryEntry[], model: string): LibraryEntry[] {
  return entries.filter((e) => e.vector === null || e.model !== model);
}

/**
 * Attach embeddings to the entries they belong to.
 *
 * Keyed by id rather than by position, because an embedding call is batched and a
 * partial response is ordinary: whatever came back is attached and the rest stays
 * pending, so the next call asks for exactly what is still missing. Matching by
 * array index would attach vectors to the wrong chunks the first time a batch came
 * back short, and nothing downstream could tell.
 */
export function withVectors(
  entries: readonly LibraryEntry[],
  vectors: ReadonlyMap<string, Vector>,
  model: string,
): LibraryEntry[] {
  return entries.map((entry) => {
    const vector = vectors.get(entry.id);
    return vector ? { ...entry, vector, model } : entry;
  });
}

/**
 * The entries that can be searched in this model's space, shaped for `topMatches`.
 *
 * This is the guard that makes `vectorSearch`'s dimension check unreachable in
 * normal operation rather than a thing users meet.
 */
export function searchable(
  entries: readonly LibraryEntry[],
  model: string,
): Embedded<LibraryEntry>[] {
  const out: Embedded<LibraryEntry>[] = [];
  for (const entry of entries) {
    if (entry.vector && entry.model === model) out.push({ item: entry, vector: entry.vector });
  }
  return out;
}

/** Remove every entry that came from one file, for a user taking a report back out. */
export function forgetSource(entries: readonly LibraryEntry[], source: string): LibraryEntry[] {
  return entries.filter((e) => e.chunk.source !== source);
}

/**
 * Persistence, kept behind two methods over the whole corpus.
 *
 * No implementation ships with this file; see *Storage* in the header for the
 * arithmetic that makes the choice between IndexedDB, a size cap and quantisation
 * a real decision rather than a default.
 */
export interface LibraryStorage {
  load(): Promise<LibraryEntry[]>;
  save(entries: readonly LibraryEntry[]): Promise<void>;
}
