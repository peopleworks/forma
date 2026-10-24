/**
 * The ordering rule is what this file exists to pin: **the import saves before it
 * embeds.** Saving afterwards would mean a network failure threw away chunking
 * already done locally, and the retry would re-hash and re-request everything.
 * Nothing else in the codebase can catch that inversion — it is invisible until
 * someone's import fails halfway and their library comes back empty.
 *
 * The retrieval cases are all about answering `''` honestly. An empty block is the
 * ordinary case, and every early return has to be a real "nothing to add" rather
 * than a swallowed failure.
 *
 * As elsewhere in this suite the loops sit inside a single case, so the grep and the
 * run agree.
 */
import { describe, it, expect, vi } from 'vitest';
import { importReports, retrieveHouseStyle, sources, removeSource, type LibraryDeps } from './library';
import type { LibraryEntry, LibraryStorage } from '../lib/embedStore';

const report = (controls: string, bandHeight = '96') =>
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<XtraReportsLayoutSerializer Ref="0" ControlType="DevExpress.XtraReports.UI.XtraReport" Name="R"><Bands>' +
  `<Item1 Ref="1" ControlType="DetailBand" Name="Detail" HeightF="${bandHeight}"><Controls>${controls}</Controls></Item1>` +
  '</Bands></XtraReportsLayoutSerializer>';

/**
 * Distinguished by FONT, not by name or text.
 *
 * `repxChunks` redacts `Name` and `Text`, so two labels differing only in those
 * are literally the same fragment and the library holds one — which is the
 * deliberate "a footer copied across thirty reports is one example" behaviour.
 * A fixture that varied the name would be testing that property by accident
 * while appearing to test something else.
 */
const label = (font: string) => `<Item1 Ref="2" ControlType="XRLabel" Name="lbl" Text="Total" Font="${font}" />`;

/** An in-memory store that records the order of writes. */
function fakeStorage(initial: LibraryEntry[] = []) {
  let held = initial;
  const writes: number[][] = [];
  const store: LibraryStorage = {
    load: async () => held,
    save: async (entries) => {
      held = entries.slice();
      writes.push(held.map((e) => (e.vector ? 1 : 0)));
    },
  };
  return { store, writes, held: () => held };
}

/** Embedding that answers a fixed vector for everything it is given. */
const fakeEmbed = (vector: number[] = [1, 0], model = 'm') =>
  vi.fn(async (entries: readonly LibraryEntry[]) => ({
    vectors: new Map(entries.map((e) => [e.id, Float32Array.from(vector)])),
    model,
    missing: 0,
  }));

const fakeEmbedTexts = (vector: number[] = [1, 0], model = 'm') =>
  vi.fn(async (texts: readonly string[]) => ({
    vectors: texts.map(() => Float32Array.from(vector)),
    model,
  }));

const deps = (over: Partial<LibraryDeps> = {}): LibraryDeps => ({
  storage: fakeStorage().store,
  embedEntries: fakeEmbed() as unknown as LibraryDeps['embedEntries'],
  embedTexts: fakeEmbedTexts() as unknown as LibraryDeps['embedTexts'],
  ...over,
});

describe('importReports', () => {
  it('chunks a report into the library and embeds it', async () => {
    const storage = fakeStorage();
    const result = await importReports([{ name: 'a.repx', text: report(label('Arial, 9pt')) }], deps({ storage: storage.store }), {
      apiKey: 'k',
    });

    expect(result.added).toBe(2); // the band and its label
    expect(result.embedded).toBe(2);
    expect(result.pending).toBe(0);
    expect(storage.held()).toHaveLength(2);
  });

  it('saves before it embeds, so a failed request cannot discard the chunking', async () => {
    const storage = fakeStorage();
    const failing = vi.fn(async () => {
      throw new Error('the key was rejected');
    });

    await expect(
      importReports([{ name: 'a.repx', text: report(label('Arial, 9pt')) }], deps({ storage: storage.store, embedEntries: failing as never }), {
        apiKey: 'k',
      }),
    ).rejects.toThrow(/rejected/);

    // The write happened anyway, and everything in it is pending rather than lost.
    expect(storage.writes).toHaveLength(1);
    expect(storage.held()).toHaveLength(2);
    expect(storage.held().every((e) => e.vector === null)).toBe(true);
  });

  it('finishes a half-embedded library on the next import', async () => {
    const storage = fakeStorage();
    const failing = vi.fn(async () => {
      throw new Error('offline');
    });
    await expect(
      importReports([{ name: 'a.repx', text: report(label('Arial, 9pt')) }], deps({ storage: storage.store, embedEntries: failing as never }), { apiKey: 'k' }),
    ).rejects.toThrow();

    const second = await importReports([], deps({ storage: storage.store }), { apiKey: 'k' });
    expect(second.added).toBe(0);
    expect(second.embedded).toBe(2);
    expect(storage.held().every((e) => e.vector !== null)).toBe(true);
  });

  it('skips a report it already holds rather than paying for it twice', async () => {
    const storage = fakeStorage();
    const file = { name: 'a.repx', text: report(label('Arial, 9pt')) };
    await importReports([file], deps({ storage: storage.store }), { apiKey: 'k' });

    const embed = fakeEmbed();
    const again = await importReports([file], deps({ storage: storage.store, embedEntries: embed as never }), { apiKey: 'k' });

    expect(again.added).toBe(0);
    expect(again.skipped).toBe(2);
    expect(embed).not.toHaveBeenCalled();
  });

  it('names a file that produced nothing instead of failing the whole import', async () => {
    const storage = fakeStorage();
    const result = await importReports(
      [
        { name: 'empty.repx', text: '' },
        { name: 'junk.repx', text: 'not xml at all' },
        { name: 'good.repx', text: report(label('Arial, 9pt')) },
      ],
      deps({ storage: storage.store }),
      { apiKey: 'k' },
    );

    expect(result.empty).toEqual(['empty.repx', 'junk.repx']);
    expect(result.added).toBe(2);
  });

  it('imports several reports in one pass', async () => {
    const storage = fakeStorage();
    const result = await importReports(
      [
        { name: 'a.repx', text: report(label('Arial, 9pt')) },
        { name: 'b.repx', text: report(label('Arial, 12pt'), '40') },
      ],
      deps({ storage: storage.store }),
      { apiKey: 'k' },
    );
    expect(result.added).toBe(4);
    expect(sources(storage.held()).map((s) => s.name)).toEqual(['a.repx', 'b.repx']);
  });
});

describe('retrieveHouseStyle', () => {
  const stocked = async () => {
    const storage = fakeStorage();
    await importReports([{ name: 'a.repx', text: report(label('Arial, 9pt')) }], deps({ storage: storage.store }), { apiKey: 'k' });
    return storage;
  };

  it('returns a block when the library has something to offer', async () => {
    const storage = await stocked();
    const block = await retrieveHouseStyle(report(label('Arial, 10pt')), 'match our totals', deps({ storage: storage.store }), {
      apiKey: 'k',
    });
    expect(block).toContain('HOUSE STYLE REFERENCE');
    expect(block).toContain('ControlType="XRLabel"');
  });

  it('answers empty for an empty library, without embedding anything', async () => {
    const embedTexts = fakeEmbedTexts();
    const block = await retrieveHouseStyle(report(label('Arial, 9pt')), 'x', deps({ embedTexts: embedTexts as never }), { apiKey: 'k' });
    expect(block).toBe('');
    expect(embedTexts).not.toHaveBeenCalled();
  });

  it('answers empty when there is nothing to ask about', async () => {
    const storage = await stocked();
    for (const [draft, instruction] of [
      [null, null],
      ['', ''],
      [undefined, '   '],
    ] as const) {
      const block = await retrieveHouseStyle(draft, instruction, deps({ storage: storage.store }), { apiKey: 'k' });
      expect(block, JSON.stringify([draft, instruction])).toBe('');
    }
  });

  it('answers empty when the library was embedded by a different model', async () => {
    // The honest nothing. searchable() filters the other space out, so this never
    // becomes a comparison between two sets of vectors.
    const storage = await stocked();
    const block = await retrieveHouseStyle(
      report(label('Arial, 10pt')),
      'x',
      deps({ storage: storage.store, embedTexts: fakeEmbedTexts([1, 0], 'a-different-model') as never }),
      { apiKey: 'k' },
    );
    expect(block).toBe('');
  });

  it('honours a canonical filter, so drafts in the library cannot become house style', async () => {
    const storage = await stocked();
    const block = await retrieveHouseStyle(report(label('Arial, 10pt')), 'x', deps({ storage: storage.store }), {
      apiKey: 'k',
      where: (entry) => entry.chunk.source === 'nothing-matches-this.repx',
    });
    expect(block).toBe('');
  });

  it('passes the block options through to the formatter', async () => {
    const storage = await stocked();
    const block = await retrieveHouseStyle(report(label('Arial, 10pt')), 'x', deps({ storage: storage.store }), {
      apiKey: 'k',
      maxExamples: 1,
    });
    expect(block.match(/--- example \d+:/g)).toHaveLength(1);
  });
});

describe('sources', () => {
  it('counts chunks and embeddings per file, sorted by name', async () => {
    const storage = fakeStorage();
    await importReports(
      [
        { name: 'b.repx', text: report(label('Arial, 9pt')) },
        { name: 'a.repx', text: report(label('Arial, 12pt'), '40') },
      ],
      deps({ storage: storage.store }),
      { apiKey: 'k' },
    );

    const rows = sources(storage.held());
    expect(rows.map((r) => r.name)).toEqual(['a.repx', 'b.repx']);
    expect(rows[0].chunks).toBe(2);
    expect(rows[0].embedded).toBe(2);
  });

  it('is empty for an empty library', () => {
    expect(sources([])).toEqual([]);
  });
});

describe('removeSource', () => {
  it('takes one file back out and leaves the rest', async () => {
    const storage = fakeStorage();
    await importReports(
      [
        { name: 'a.repx', text: report(label('Arial, 9pt')) },
        { name: 'b.repx', text: report(label('Arial, 12pt'), '40') },
      ],
      deps({ storage: storage.store }),
      { apiKey: 'k' },
    );

    const left = await removeSource('a.repx', deps({ storage: storage.store }));
    expect(sources(left).map((s) => s.name)).toEqual(['b.repx']);
    expect(sources(storage.held()).map((s) => s.name)).toEqual(['b.repx']);
  });
});
