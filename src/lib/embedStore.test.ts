/**
 * The cases that matter here are the silent ones.
 *
 * **Dedup by content**, because the alternative is paying the user's embedding
 * quota twice for the same import and filling every retrieval slot with thirty
 * copies of one page footer.
 *
 * **Attaching vectors by id rather than by position**, because a batched embedding
 * call coming back short is ordinary, and matching by index would put vectors on
 * the wrong chunks with nothing downstream able to tell.
 *
 * **`searchable` filtering by model**, because that is what stops two embedding
 * spaces being compared — `vectorSearch.cosine` throwing is the last line of
 * defence, not the first.
 *
 * As elsewhere in this suite the loops sit inside a single case, so the grep and the
 * run agree.
 */
import { describe, it, expect } from 'vitest';
import {
  addChunks,
  contentId,
  entriesToEmbed,
  forgetSource,
  searchable,
  withVectors,
  type LibraryEntry,
} from './embedStore';
import { chunkRepx } from './repxChunks';
import { topMatches } from './vectorSearch';
import type { RepxChunk } from './repxChunks';

const chunk = (xml: string, source = 'a.repx'): RepxChunk => ({
  kind: 'control',
  controlType: 'XRLabel',
  band: 'DetailBand',
  caption: 'label in the detail band',
  xml,
  source,
  redacted: 0,
  start: 0,
});

const MODEL = 'text-embedding-x';

describe('contentId', () => {
  it('is stable for the same text and different for different text', () => {
    expect(contentId('<Item1 />')).toBe(contentId('<Item1 />'));
    expect(contentId('<Item1 />')).not.toBe(contentId('<Item2 />'));
  });

  it('is a fixed-width hex string, so it is safe as a key', () => {
    for (const text of ['', '<a/>', 'x'.repeat(5000), 'unicode — dash']) {
      const id = contentId(text);
      expect(id, JSON.stringify(text.slice(0, 12))).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('separates texts that a weak hash would collide', () => {
    // Anagrams and transpositions are where a naive additive hash fails.
    const ids = new Set(['ab', 'ba', 'abc', 'acb', 'cab'].map(contentId));
    expect(ids.size).toBe(5);
  });
});

describe('addChunks', () => {
  it('adds new chunks and reports how many', () => {
    const result = addChunks([], [chunk('<a/>'), chunk('<b/>')], 1000);
    expect(result.added).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].addedAt).toBe(1000);
  });

  it('starts every entry unembedded, because embedding is a separate batched call', () => {
    const { entries } = addChunks([], [chunk('<a/>')]);
    expect(entries[0].vector).toBeNull();
    expect(entries[0].model).toBe('');
  });

  it('skips a chunk it already holds, so re-importing a file costs no quota', () => {
    const first = addChunks([], [chunk('<a/>'), chunk('<b/>')]);
    const again = addChunks(first.entries, [chunk('<a/>'), chunk('<b/>')]);
    expect(again.added).toBe(0);
    expect(again.skipped).toBe(2);
    expect(again.entries).toHaveLength(2);
  });

  it('treats the same fragment in two files as one entry, keeping the first source', () => {
    // A footer copied across thirty reports IS the house style; it should be one
    // example the search can return, not thirty identical hits.
    const { entries, added, skipped } = addChunks([], [chunk('<a/>', 'one.repx'), chunk('<a/>', 'two.repx')]);
    expect(added).toBe(1);
    expect(skipped).toBe(1);
    expect(entries[0].chunk.source).toBe('one.repx');
  });

  it('treats an edited fragment as new, rather than keeping a vector for the old text', () => {
    const before = addChunks([], [chunk('<Item1 Text="{text}" />')]);
    const after = addChunks(before.entries, [chunk('<Item1 Text="{text}" Font="Arial, 9pt" />')]);
    expect(after.added).toBe(1);
    expect(after.entries).toHaveLength(2);
  });

  it('does not mutate what it was given', () => {
    const existing = addChunks([], [chunk('<a/>')]).entries;
    const copy = existing.slice();
    addChunks(existing, [chunk('<b/>')]);
    expect(existing).toEqual(copy);
    expect(existing).toHaveLength(1);
  });

  it('takes the chunks a real report produces', () => {
    const xml =
      '<XtraReportsLayoutSerializer Ref="0" ControlType="DevExpress.XtraReports.UI.XtraReport" Name="R"><Bands>' +
      '<Item1 Ref="1" ControlType="DetailBand" Name="Detail" HeightF="96"><Controls>' +
      '<Item1 Ref="2" ControlType="XRLabel" Name="l" Text="Total" Font="Arial, 9pt" />' +
      '</Controls></Item1></Bands></XtraReportsLayoutSerializer>';
    const { entries, added } = addChunks([], chunkRepx(xml, 'real.repx'));
    expect(added).toBe(2);
    expect(entries.every((e) => e.id.length === 16)).toBe(true);
  });
});

describe('entriesToEmbed', () => {
  it('names everything with no vector', () => {
    const { entries } = addChunks([], [chunk('<a/>'), chunk('<b/>')]);
    expect(entriesToEmbed(entries, MODEL)).toHaveLength(2);
  });

  it('names everything embedded by a different model, so a model change is a re-embed', () => {
    const { entries } = addChunks([], [chunk('<a/>')]);
    const embedded = withVectors(entries, new Map([[entries[0].id, [1, 0]]]), 'old-model');
    expect(entriesToEmbed(embedded, 'old-model')).toHaveLength(0);
    expect(entriesToEmbed(embedded, 'new-model')).toHaveLength(1);
  });
});

describe('withVectors', () => {
  it('attaches by id, not by position, so a short batch cannot misalign', () => {
    const { entries } = addChunks([], [chunk('<a/>'), chunk('<b/>'), chunk('<c/>')]);
    // Only the middle one came back -- the case that silently corrupts an
    // index-matched implementation.
    const result = withVectors(entries, new Map([[entries[1].id, [0, 1]]]), MODEL);

    expect(result[0].vector).toBeNull();
    expect(result[1].vector).toEqual([0, 1]);
    expect(result[1].model).toBe(MODEL);
    expect(result[2].vector).toBeNull();
  });

  it('leaves entries alone when nothing came back', () => {
    const { entries } = addChunks([], [chunk('<a/>')]);
    expect(withVectors(entries, new Map(), MODEL)[0].vector).toBeNull();
  });

  it('lets a later call finish what an earlier one left pending', () => {
    const { entries } = addChunks([], [chunk('<a/>'), chunk('<b/>')]);
    const half = withVectors(entries, new Map([[entries[0].id, [1, 0]]]), MODEL);
    const pending = entriesToEmbed(half, MODEL);
    expect(pending).toHaveLength(1);

    const whole = withVectors(half, new Map([[pending[0].id, [0, 1]]]), MODEL);
    expect(entriesToEmbed(whole, MODEL)).toHaveLength(0);
  });
});

describe('searchable', () => {
  const build = (): LibraryEntry[] => {
    const { entries } = addChunks([], [chunk('<a/>'), chunk('<b/>'), chunk('<c/>')]);
    const withOne = withVectors(entries, new Map([[entries[0].id, [1, 0]]]), MODEL);
    return withVectors(withOne, new Map([[entries[1].id, [0, 1, 0]]]), 'other-model');
  };

  it('returns only what is embedded in this model space', () => {
    const ready = searchable(build(), MODEL);
    expect(ready).toHaveLength(1);
    expect(ready[0].vector).toEqual([1, 0]);
  });

  it('is what makes a dimension mismatch unreachable in normal use', () => {
    // The library deliberately holds a 3-dimension vector from another model. Going
    // through searchable, a 2-dimension query never meets it.
    const entries = build();
    expect(() => topMatches([1, 0], searchable(entries, MODEL), { k: 5 })).not.toThrow();

    const unguarded = entries
      .filter((e) => e.vector)
      .map((e) => ({ item: e, vector: e.vector as readonly number[] }));
    expect(() => topMatches([1, 0], unguarded, { k: 5 })).toThrow(/dimension mismatch/);
  });

  it('returns nothing when the library is empty or none of it is embedded', () => {
    expect(searchable([], MODEL)).toEqual([]);
    expect(searchable(addChunks([], [chunk('<a/>')]).entries, MODEL)).toEqual([]);
  });
});

describe('forgetSource', () => {
  it('removes every entry that came from one file and leaves the rest', () => {
    const { entries } = addChunks([], [chunk('<a/>', 'one.repx'), chunk('<b/>', 'two.repx')]);
    const left = forgetSource(entries, 'one.repx');
    expect(left).toHaveLength(1);
    expect(left[0].chunk.source).toBe('two.repx');
  });

  it('leaves the library alone for a file it does not hold', () => {
    const { entries } = addChunks([], [chunk('<a/>', 'one.repx')]);
    expect(forgetSource(entries, 'nothing.repx')).toHaveLength(1);
  });
});
