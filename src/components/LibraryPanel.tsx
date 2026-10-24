/**
 * The report library: the files it holds, and what goes into it.
 *
 * The visible half of milestone 6 in `docs/proposals/rag.md`. `services/library.ts`
 * does the work; this shows what is in the library, takes `.repx` files in, and
 * lets a file be taken back out.
 *
 * ## Curation is a control, not a nicety
 *
 * The 19 real reports this feature was measured against include five
 * `Job_Card_Report (1)…(5)` variants, two near-empty files of one and three chunks,
 * and 13 fragments duplicated across files. Importing a folder wholesale would make
 * drafts and stubs into house style, and the model would then be shown them as
 * examples of how this organisation formats reports.
 *
 * So **canonical is per file and off by default**. A file contributes to retrieval
 * only once someone has said it should. That is the *"who decides what is
 * canonical"* question from the proposal, answered as an explicit act rather than
 * by an import path.
 *
 * ## Only `.repx` goes in
 *
 * A screenshot or a PDF has no structure `repxChunks` can read, so admitting one
 * would add a file to the list that contributes nothing and looks broken. The
 * picker filters, and a file that produces no chunks is reported by name rather
 * than silently ignored — `Sample empt report..repx` in the real corpus is exactly
 * that case.
 */
import { useCallback, useRef, useState } from 'react';
import type { ImportResult, LibrarySource } from '../services/library';

export interface LibraryPanelProps {
  /** One row per file already in the library. */
  sources: readonly LibrarySource[];
  /** Which file names count as house style. */
  canonical: ReadonlySet<string>;
  /** Reads the chosen files and puts them in the library. */
  onImport: (files: File[]) => Promise<ImportResult>;
  onRemove: (name: string) => void;
  onToggleCanonical: (name: string, canonical: boolean) => void;
  /** False when there is no API key — importing needs one, to embed. */
  ready: boolean;
  onNeedKey: () => void;
}

export default function LibraryPanel({
  sources,
  canonical,
  onImport,
  onRemove,
  onToggleCanonical,
  ready,
  onNeedKey,
}: LibraryPanelProps) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const chosen = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      // The picker is reset immediately so the same file can be chosen twice --
      // after a failure, re-picking it is the obvious thing to try.
      event.target.value = '';
      if (files.length === 0) return;

      setBusy(true);
      setError('');
      setNotice('');
      try {
        const result = await onImport(files);
        const parts = [`${result.added} fragment(s) added`];
        if (result.skipped) parts.push(`${result.skipped} already held`);
        if (result.pending) parts.push(`${result.pending} still to embed`);
        setNotice(parts.join(' · '));
        if (result.empty.length) {
          setError(`No report content found in ${result.empty.join(', ')}.`);
        }
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : 'The import failed.');
      } finally {
        setBusy(false);
      }
    },
    [onImport],
  );

  const total = sources.reduce((n, source) => n + source.chunks, 0);
  const waiting = sources.reduce((n, source) => n + (source.chunks - source.embedded), 0);

  return (
    <div className="lp-panel">
      {/* Button above the prose, and the outline pill rather than the accent one:
          both match BatchPanel, which is the panel beside this one in the rail.
          An accent pill here would compete with "New report" in the same column. */}
      <div className="lp-actions">
        <button
          className="wb-pill wb-pill--outline"
          disabled={busy}
          onClick={() => (ready ? input.current?.click() : onNeedKey())}
        >
          {busy ? 'Importing…' : 'Add .repx files'}
        </button>
        <input
          ref={input}
          type="file"
          accept=".repx"
          multiple
          hidden
          onChange={chosen}
        />
      </div>

      <p className="lp-intro">
        Reports you have already published. Forma matches their formatting when you ask it to.
      </p>

      {!ready && (
        <p className="lp-hint">Importing needs your API key, because each fragment is embedded once.</p>
      )}
      {notice && <p className="lp-notice">{notice}</p>}
      {error && <p className="lp-error">{error}</p>}

      {sources.length === 0 ? (
        <p className="lp-empty">
          Nothing here yet. Add a few reports that look the way you want new ones to look.
        </p>
      ) : (
        <>
          <p className="lp-summary">
            {sources.length} file(s) · {total} fragment(s)
            {waiting > 0 && ` · ${waiting} not yet embedded`}
          </p>
          <ul className="lp-list">
            {sources.map((source) => {
              const isCanonical = canonical.has(source.name);
              return (
                <li className="lp-row" key={source.name}>
                  <label className="lp-canonical">
                    <input
                      type="checkbox"
                      checked={isCanonical}
                      onChange={(e) => onToggleCanonical(source.name, e.target.checked)}
                      aria-label={`Use ${source.name} as house style`}
                    />
                  </label>
                  <span className="lp-name" title={source.name}>
                    {source.name}
                  </span>
                  <span className="lp-count">
                    {source.chunks}
                    {source.embedded < source.chunks && ` (${source.embedded} ready)`}
                  </span>
                  <button className="wb-pill wb-pill--outline" onClick={() => onRemove(source.name)}>
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
          {canonical.size === 0 && (
            <p className="lp-hint">
              Tick the reports that represent your house style. Nothing is used until you do.
            </p>
          )}
        </>
      )}
    </div>
  );
}
