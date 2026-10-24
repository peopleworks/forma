/**
 * The two things a user does with a report library: fill it, and use it.
 *
 * Milestone 6 of `docs/proposals/rag.md`, minus the panel that calls it. Everything
 * built before this is a pure function over a list; this is where chunking, a
 * store, an embedding request and a search become *import these files* and *match
 * our house style*.
 *
 * ## Dependencies are injected, because this is the one file that does all the IO
 *
 * `LibraryDeps` names the store and the two embedding calls. `defaultDeps()` wires
 * the real ones. A test supplies its own and gets the whole orchestration under
 * assertion without IndexedDB or a network, which is the only way the ordering
 * rules below can be checked at all.
 *
 * ## The import saves before it embeds, and that ordering is the point
 *
 * Chunking is local and instant; embedding is a network request against the user's
 * own quota that can fail halfway. So the entries are written to the store the
 * moment they exist, *before* a single vector is asked for. A failed embedding then
 * costs nothing — the chunks are in the library, `entriesToEmbed` will name them
 * next time, and the second attempt asks only for what is still missing.
 *
 * Saving afterwards instead would mean a network failure discarded work already
 * done locally, and the retry would re-chunk, re-hash and re-request everything.
 *
 * ## Retrieval answers with a string, and an empty one is an ordinary answer
 *
 * `retrieveHouseStyle` returns the block for `previousState.houseStyle`, or `''`.
 * Empty is the common case rather than the failure case: no library yet, nothing
 * canonical, no query worth asking, or nothing scoring above the threshold. The
 * caller appends it unconditionally and the prompt is unchanged when it is empty.
 *
 * **It refuses rather than degrades on one thing only**: a library embedded with a
 * different model than the one answering now. `searchable()` filters those out, so
 * the result is an honest nothing rather than a comparison between two spaces.
 */
import { chunkRepx } from '../lib/repxChunks';
import {
  addChunks,
  entriesToEmbed,
  searchable,
  withVectors,
  forgetSource,
  type LibraryEntry,
  type LibraryStorage,
} from '../lib/embedStore';
import { houseStyleBlock, mergeMatches, styleQueries, type StyleBlockOptions } from '../lib/houseStyle';
import { topMatches, type Match } from '../lib/vectorSearch';
import { createLibraryStorage } from '../lib/libraryDb';
import { embedEntries, embedTexts } from './embeddings';

export interface LibraryDeps {
  storage: LibraryStorage;
  embedEntries: typeof embedEntries;
  embedTexts: typeof embedTexts;
}

/** The real wiring. A caller that is not a test wants this. */
export function defaultDeps(): LibraryDeps {
  return { storage: createLibraryStorage(), embedEntries, embedTexts };
}

/** One file on its way in. Text rather than a File, so this needs no DOM. */
export interface ReportFile {
  name: string;
  text: string;
}

export interface ImportResult {
  /** Chunks new to the library. */
  added: number;
  /** Chunks already held, by content — a re-import costs nothing. */
  skipped: number;
  /** How many got a vector this time. */
  embedded: number;
  /** Chunks still waiting for one, which the next import will pick up. */
  pending: number;
  /** Files that produced no chunks at all. */
  empty: string[];
}

/**
 * Chunk these reports into the library and embed whatever still needs it.
 *
 * Embeds every pending entry rather than only the new ones, so an import after a
 * failed one finishes the job instead of leaving a permanently half-embedded
 * library.
 */
export async function importReports(
  files: readonly ReportFile[],
  deps: LibraryDeps,
  options: { apiKey: string; signal?: AbortSignal; onProgress?: (done: number, total: number) => void },
): Promise<ImportResult> {
  const existing = await deps.storage.load();

  let entries = existing;
  let added = 0;
  let skipped = 0;
  const empty: string[] = [];

  for (const file of files) {
    const chunks = chunkRepx(file.text, file.name);
    if (chunks.length === 0) {
      empty.push(file.name);
      continue;
    }
    const merged = addChunks(entries, chunks);
    entries = merged.entries;
    added += merged.added;
    skipped += merged.skipped;
  }

  // Before the network, deliberately -- see the header.
  await deps.storage.save(entries);

  const pending = entriesToEmbed(entries, '');
  const toEmbed = entries.filter((e) => e.vector === null);
  if (toEmbed.length === 0) {
    return { added, skipped, embedded: 0, pending: pending.length, empty };
  }

  const { vectors, model } = await deps.embedEntries(toEmbed, {
    apiKey: options.apiKey,
    signal: options.signal,
    onProgress: options.onProgress,
  });

  if (vectors.size > 0) {
    entries = withVectors(entries, vectors, model);
    await deps.storage.save(entries);
  }

  return {
    added,
    skipped,
    embedded: vectors.size,
    pending: entries.filter((e) => e.vector === null).length,
    empty,
  };
}

export interface RetrieveOptions extends StyleBlockOptions {
  apiKey: string;
  signal?: AbortSignal;
  /** Restrict retrieval to a chosen subset — the canonical set. */
  where?: (entry: LibraryEntry) => boolean;
  /** How many matches each query contributes before merging. */
  perQuery?: number;
}

/**
 * Build the house-style block for a refine, or `''`.
 *
 * Every early return is a legitimate "nothing to add" rather than an error: the
 * library is empty, the draft and the instruction between them ask nothing, or the
 * stored vectors belong to another model.
 */
export async function retrieveHouseStyle(
  draftRepx: string | null | undefined,
  instruction: string | null | undefined,
  deps: LibraryDeps,
  options: RetrieveOptions,
): Promise<string> {
  const entries = await deps.storage.load();
  if (entries.length === 0) return '';

  const queries = styleQueries(draftRepx, instruction);
  if (queries.length === 0) return '';

  const { vectors, model } = await deps.embedTexts(queries, {
    apiKey: options.apiKey,
    signal: options.signal,
  });

  const candidates = searchable(entries, model).filter(
    (candidate) => !options.where || options.where(candidate.item),
  );
  if (candidates.length === 0) return '';

  const perQuery = options.perQuery ?? 4;
  const results: Match<LibraryEntry>[][] = vectors.map((vector) =>
    topMatches(vector, candidates, { k: perQuery, minScore: options.minScore }),
  );

  return houseStyleBlock(mergeMatches(results), options);
}

/** What the panel lists: one row per file, not per chunk. */
export interface LibrarySource {
  name: string;
  chunks: number;
  embedded: number;
}

/** Group the library by the file each chunk came from, for display. */
export function sources(entries: readonly LibraryEntry[]): LibrarySource[] {
  const byName = new Map<string, LibrarySource>();

  for (const entry of entries) {
    const name = entry.chunk.source || '(unnamed)';
    const row = byName.get(name) ?? { name, chunks: 0, embedded: 0 };
    row.chunks++;
    if (entry.vector) row.embedded++;
    byName.set(name, row);
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Take one file back out of the library. */
export async function removeSource(name: string, deps: LibraryDeps): Promise<LibraryEntry[]> {
  const entries = await deps.storage.load();
  const left = forgetSource(entries, name);
  await deps.storage.save(left);
  return left;
}
