/**
 * The record mapping, which is the part that outlives the code that wrote it.
 *
 * A stored record is read by every version of the app that comes after the one
 * that wrote it, so the cases worth testing are the malformed ones: a field that
 * is missing, a field that is the wrong type, and the one state that cannot repair
 * itself — a vector with no model naming the space it belongs to.
 *
 * The IndexedDB calls have no test here and that is deliberate; see the header of
 * `libraryDb.ts` for why, and `docs/notes/testing.md` for the same judgement
 * already recorded about `ReportPreview`.
 *
 * As elsewhere in this suite the loops sit inside a single case, so the grep and the
 * run agree.
 */
import { describe, it, expect } from 'vitest';
import { fromRecord, toRecord, LIBRARY_DB_NAME, LIBRARY_STORE } from './libraryDb';
import { addChunks, searchable, entriesToEmbed, type LibraryEntry } from './embedStore';
import type { RepxChunk } from './repxChunks';

const chunk: RepxChunk = {
  kind: 'control',
  controlType: 'XRLabel',
  band: 'DetailBand',
  caption: 'label in the detail band',
  xml: '<Item1 ControlType="XRLabel" Text="{text}" />',
  source: 'a.repx',
  redacted: 1,
  start: 0,
};

const entry = (over: Partial<LibraryEntry> = {}): LibraryEntry => ({
  id: 'abc123',
  chunk,
  vector: [1, 0, 0],
  model: 'embed-1',
  addedAt: 1700000000000,
  ...over,
});

describe('toRecord', () => {
  it('narrows the vector to binary, which is the reason for IndexedDB at all', () => {
    const record = toRecord(entry());
    expect(record.vector).toBeInstanceOf(Float32Array);
    expect(Array.from(record.vector!)).toEqual([1, 0, 0]);
  });

  it('keeps a null vector null rather than inventing an empty one', () => {
    // An empty Float32Array would read as "embedded, dimension 0" downstream.
    expect(toRecord(entry({ vector: null, model: '' })).vector).toBeNull();
  });

  it('accepts a Float32Array it is already given', () => {
    const record = toRecord(entry({ vector: new Float32Array([0.5, 0.25]) }));
    expect(Array.from(record.vector!)).toEqual([0.5, 0.25]);
  });

  it('round-trips through fromRecord unchanged', () => {
    const original = entry();
    const back = fromRecord(toRecord(original));
    expect(back?.id).toBe(original.id);
    expect(back?.model).toBe(original.model);
    expect(back?.addedAt).toBe(original.addedAt);
    expect(back?.chunk).toEqual(original.chunk);
    expect(Array.from(back!.vector as Float32Array)).toEqual([1, 0, 0]);
  });
});

describe('fromRecord', () => {
  it('rejects anything that is not a usable record', () => {
    const rubbish: unknown[] = [
      null,
      undefined,
      42,
      'a string',
      {},
      { id: '', chunk, addedAt: 1 },
      { id: 'a', addedAt: 1 },
      { id: 'a', chunk: null, addedAt: 1 },
      { id: 'a', chunk: { caption: 'no xml' }, addedAt: 1 },
      { id: 'a', chunk, addedAt: 'yesterday' },
      { id: 'a', chunk, addedAt: NaN },
    ];
    for (const record of rubbish) {
      expect(fromRecord(record), JSON.stringify(record)).toBeNull();
    }
  });

  it('drops one bad record without taking the library with it', () => {
    const records: unknown[] = [toRecord(entry({ id: 'good1' })), { broken: true }, toRecord(entry({ id: 'good2' }))];
    const kept = records.map(fromRecord).filter(Boolean);
    expect(kept).toHaveLength(2);
  });

  it('treats a missing model as unembedded rather than as an empty-string space', () => {
    expect(fromRecord({ id: 'a', chunk, addedAt: 1, vector: new Float32Array([1]) })?.model).toBe('');
  });

  it('sends a vector with no model back to pending, the one state that repairs itself', () => {
    // searchable() matches on model, so such a vector can never be searched; and
    // entriesToEmbed() only looks for a missing vector or a different model, so it
    // would never be re-embedded either. Dropping the vector fixes both.
    const recovered = fromRecord({ id: 'a', chunk, addedAt: 1, vector: new Float32Array([1, 0]), model: '' });
    expect(recovered?.vector).toBeNull();
    expect(searchable([recovered!], 'embed-1')).toEqual([]);
    expect(entriesToEmbed([recovered!], 'embed-1')).toHaveLength(1);
  });

  it('accepts a plain array vector, because an older record may hold one', () => {
    const recovered = fromRecord({ id: 'a', chunk, addedAt: 1, vector: [1, 0], model: 'embed-1' });
    expect(recovered?.vector).toEqual([1, 0]);
  });

  it('ignores a vector of the wrong type instead of storing it', () => {
    for (const bad of ['1,0', { 0: 1 }, 7]) {
      const recovered = fromRecord({ id: 'a', chunk, addedAt: 1, vector: bad, model: 'embed-1' });
      expect(recovered?.vector, JSON.stringify(bad)).toBeNull();
    }
  });

  it('survives a whole library written by addChunks', () => {
    const { entries } = addChunks([], [chunk, { ...chunk, xml: '<Item1 ControlType="XRLine" />' }]);
    const back = entries.map(toRecord).map(fromRecord);
    expect(back.every(Boolean)).toBe(true);
    expect(back.map((e) => e!.id)).toEqual(entries.map((e) => e.id));
  });
});

describe('the store it writes to', () => {
  it('names a database and an object store, so a migration can find them', () => {
    expect(LIBRARY_DB_NAME).toBe('forma-library');
    expect(LIBRARY_STORE).toBe('entries');
  });
});
