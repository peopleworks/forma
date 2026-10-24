// @vitest-environment jsdom
/**
 * The panel's job is to stop the library filling with things that should not be
 * house style, so that is what these check.
 *
 * **Canonical is off by default.** The real corpus this was measured against holds
 * five `Job_Card_Report (1)…(5)` variants and two near-empty stubs; an import path
 * that made everything canonical would show a model a draft as an example of how
 * this organisation formats reports.
 *
 * **A file that produced nothing is named.** `Sample empt report..repx` exists in
 * that corpus. Silently ignoring it leaves someone waiting for a file that is never
 * going to appear in the list.
 *
 * **The picker is cleared after a pick**, because re-choosing the same file is the
 * obvious response to a failed import and a file input will not fire `change` for
 * an unchanged value.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import LibraryPanel from './LibraryPanel';
import type { ImportResult, LibrarySource } from '../services/library';

afterEach(cleanup);

const result = (over: Partial<ImportResult> = {}): ImportResult => ({
  added: 2,
  skipped: 0,
  embedded: 2,
  pending: 0,
  empty: [],
  ...over,
});

const source = (name: string, chunks = 4, embedded = 4): LibrarySource => ({ name, chunks, embedded });

const panel = (over: Partial<React.ComponentProps<typeof LibraryPanel>> = {}) => {
  const props = {
    sources: [] as readonly LibrarySource[],
    canonical: new Set<string>(),
    onImport: vi.fn(async () => result()),
    onRemove: vi.fn(),
    onToggleCanonical: vi.fn(),
    ready: true,
    onNeedKey: vi.fn(),
    ...over,
  };
  render(<LibraryPanel {...props} />);
  return props;
};

/** Puts files into the panel's own input, as a picker would. */
const choose = (names: string[]) => {
  const input = document.querySelector('input[type=file]') as HTMLInputElement;
  const files = names.map((name) => new File(['<xml/>'], name, { type: 'text/xml' }));
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
  return input;
};

describe('an empty library', () => {
  it('says what to put in it rather than showing an empty list', () => {
    panel();
    expect(screen.getByText(/Nothing here yet/)).toBeTruthy();
  });

  it('offers the import button', () => {
    panel();
    expect(screen.getByRole('button', { name: /Add \.repx files/ })).toBeTruthy();
  });
});

describe('importing', () => {
  it('only offers .repx, because nothing else has structure to read', () => {
    panel();
    expect(document.querySelector('input[type=file]')?.getAttribute('accept')).toBe('.repx');
  });

  it('hands the chosen files over and reports what happened', async () => {
    // Held separately from the props object: the spread in `panel` widens the
    // mock to its plain function type and `tsc` then loses `.mock`.
    const onImport = vi.fn(async (_files: File[]) => result({ added: 7, skipped: 3 }));
    panel({ onImport });
    choose(['a.repx', 'b.repx']);

    await waitFor(() => expect(onImport).toHaveBeenCalled());
    expect(onImport.mock.calls[0][0].map((f) => f.name)).toEqual(['a.repx', 'b.repx']);
    await waitFor(() => expect(screen.getByText(/7 fragment\(s\) added/)).toBeTruthy());
    expect(screen.getByText(/3 already held/)).toBeTruthy();
  });

  it('names a file that produced no report content', async () => {
    panel({ onImport: vi.fn(async () => result({ empty: ['Sample empt report..repx'] })) });
    choose(['Sample empt report..repx']);
    await waitFor(() => expect(screen.getByText(/No report content found in Sample empt report/)).toBeTruthy());
  });

  it('says when fragments are still waiting to be embedded', async () => {
    panel({ onImport: vi.fn(async () => result({ pending: 5 })) });
    choose(['a.repx']);
    await waitFor(() => expect(screen.getByText(/5 still to embed/)).toBeTruthy());
  });

  it('shows the failure instead of pretending the import worked', async () => {
    panel({ onImport: vi.fn(async () => { throw new Error('the key was rejected'); }) });
    choose(['a.repx']);
    await waitFor(() => expect(screen.getByText('the key was rejected')).toBeTruthy());
  });

  it('clears the picker so the same file can be chosen again after a failure', async () => {
    panel({ onImport: vi.fn(async () => { throw new Error('nope'); }) });
    const input = choose(['a.repx']);
    await waitFor(() => expect(screen.getByText('nope')).toBeTruthy());
    expect(input.value).toBe('');
  });

  it('does nothing at all when the picker was cancelled', async () => {
    const props = panel();
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [], configurable: true });
    fireEvent.change(input);
    expect(props.onImport).not.toHaveBeenCalled();
  });

  it('asks for a key instead of opening a picker that cannot finish', () => {
    const props = panel({ ready: false });
    fireEvent.click(screen.getByRole('button', { name: /Add \.repx files/ }));
    expect(props.onNeedKey).toHaveBeenCalled();
    expect(props.onImport).not.toHaveBeenCalled();
    expect(screen.getByText(/Importing needs your API key/)).toBeTruthy();
  });
});

describe('a stocked library', () => {
  const stocked = [source('Invoice.repx'), source('Job_Card_Report.repx', 11, 8)];

  it('lists each file once, with its fragment count', () => {
    panel({ sources: stocked });
    expect(screen.getByText('Invoice.repx')).toBeTruthy();
    expect(screen.getByText('Job_Card_Report.repx')).toBeTruthy();
    expect(screen.getByText(/2 file\(s\) · 15 fragment\(s\)/)).toBeTruthy();
  });

  it('says how many are not embedded yet, rather than implying all are usable', () => {
    panel({ sources: stocked });
    expect(screen.getByText(/3 not yet embedded/)).toBeTruthy();
    expect(screen.getByText(/8 ready/)).toBeTruthy();
  });

  it('leaves every file un-canonical until someone says otherwise', () => {
    panel({ sources: stocked });
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.every((box) => !box.checked)).toBe(true);
    expect(screen.getByText(/Nothing is used until you do/)).toBeTruthy();
  });

  it('reports a file being made canonical', () => {
    const props = panel({ sources: stocked });
    fireEvent.click(screen.getByLabelText('Use Invoice.repx as house style'));
    expect(props.onToggleCanonical).toHaveBeenCalledWith('Invoice.repx', true);
  });

  it('reports a file being taken back out of the canonical set', () => {
    const props = panel({ sources: stocked, canonical: new Set(['Invoice.repx']) });
    fireEvent.click(screen.getByLabelText('Use Invoice.repx as house style'));
    expect(props.onToggleCanonical).toHaveBeenCalledWith('Invoice.repx', false);
  });

  it('stops nagging once something is canonical', () => {
    panel({ sources: stocked, canonical: new Set(['Invoice.repx']) });
    expect(screen.queryByText(/Nothing is used until you do/)).toBeNull();
  });

  it('removes a file by name', () => {
    const props = panel({ sources: stocked });
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]);
    expect(props.onRemove).toHaveBeenCalledWith('Invoice.repx');
  });
});
