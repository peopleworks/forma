/**
 * The cases that matter here are the two that fail silently.
 *
 * **Redaction**, because a fragment that keeps `Text="Acme Ltd"` produces a report
 * for the wrong company and nothing in the pipeline objects; and `Ref`, because a
 * copied one makes the DevExpress loader discard content with no error.
 *
 * **Nesting**, because chunking a panel's children as well as the panel returns the
 * same XML twice for one query, which costs retrieval budget and looks like two
 * pieces of evidence agreeing.
 *
 * As elsewhere in this suite the loops sit inside a single case, so the grep and the
 * run agree.
 */
import { describe, it, expect } from 'vitest';
import { chunkRepx, REDACTIONS, type RepxChunk } from './repxChunks';

const wrap = (bands: string) =>
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<XtraReportsLayoutSerializer SerializerVersion="20.1.3.0" Ref="0" ' +
  'ControlType="DevExpress.XtraReports.UI.XtraReport" Name="Report1" PageWidth="850" PageHeight="1100">' +
  `<Bands>${bands}</Bands></XtraReportsLayoutSerializer>`;

const label = (attrs: string) =>
  `<Item1 Ref="7" ControlType="XRLabel" Name="label1" ${attrs} />`;

const detail = (controls: string, attrs = 'HeightF="96"') =>
  `<Item2 Ref="2" ControlType="DetailBand" Name="Detail" ${attrs}>` +
  `<Controls>${controls}</Controls></Item2>`;

const kinds = (chunks: readonly RepxChunk[]) => chunks.map((c) => c.controlType);

describe('chunkRepx', () => {
  it('returns nothing for input it cannot read', () => {
    for (const input of ['', '   ', '\n', null, undefined]) {
      expect(chunkRepx(input), JSON.stringify(input)).toEqual([]);
    }
  });

  it('returns what it has rather than throwing on a truncated document', () => {
    // A half-written .repx is a real input -- see repxTruncation.ts. An import of
    // two hundred files must not stop on the first bad one.
    const cut = wrap(detail(label('Text="Total"'))).slice(0, 320);
    expect(() => chunkRepx(cut)).not.toThrow();
    expect(Array.isArray(chunkRepx(cut))).toBe(true);
  });

  it('chunks every band, and the report root is not one', () => {
    const chunks = chunkRepx(
      wrap(
        '<Item1 Ref="1" ControlType="TopMarginBand" Name="TopMargin" HeightF="100" />' +
          detail(label('Text="Total"')) +
          '<Item3 Ref="3" ControlType="PageFooterBand" Name="PageFooter" HeightF="40" />',
      ),
    );
    expect(kinds(chunks.filter((c) => c.kind === 'band'))).toEqual([
      'TopMarginBand',
      'DetailBand',
      'PageFooterBand',
    ]);
    expect(kinds(chunks)).not.toContain('XtraReport');
  });

  it('names a band as its own band, so every chunk answers the same question', () => {
    const [band] = chunkRepx(wrap('<Item1 Ref="1" ControlType="DetailBand" Name="Detail" />'));
    expect(band.kind).toBe('band');
    expect(band.band).toBe('DetailBand');
  });

  it('chunks a control directly inside a band, and records which band', () => {
    const chunks = chunkRepx(wrap(detail(label('Text="Total"'))));
    const control = chunks.find((c) => c.kind === 'control');
    expect(control?.controlType).toBe('XRLabel');
    expect(control?.band).toBe('DetailBand');
  });

  it('leaves a nested control inside its parent instead of chunking it twice', () => {
    const panel =
      '<Item1 Ref="5" ControlType="XRPanel" Name="panel1" SizeF="200,50">' +
      `<Controls>${label('Text="Inner"')}</Controls></Item1>`;
    const chunks = chunkRepx(wrap(detail(panel)));

    expect(kinds(chunks)).toEqual(['DetailBand', 'XRPanel']);
    // The label is not lost -- it travels inside the panel's fragment.
    const panelChunk = chunks.find((c) => c.controlType === 'XRPanel');
    expect(panelChunk?.xml).toContain('XRLabel');
  });

  it('keeps table rows and cells inside the table, though they are typed controls', () => {
    // Cells DO carry a ControlType -- all 47 of them in rptWorkerLedger_DJ.repx do,
    // Text and all. They stay out of the chunk list because of the nesting rule and
    // for no other reason, so this fixture carries the attribute that real files do.
    const table =
      '<Item1 Ref="9" ControlType="XRTable" Name="table1" SizeF="650,25"><Rows>' +
      '<Item1 Ref="10" ControlType="XRTableRow" Name="tableRow1"><Cells>' +
      '<Item1 Ref="11" ControlType="XRTableCell" Name="tableCell1" Text="Qty" />' +
      '</Cells></Item1></Rows></Item1>';
    expect(kinds(chunkRepx(wrap(detail(table))))).toEqual(['DetailBand', 'XRTable']);
  });

  it('reads an assembly-qualified ControlType as its bare type name', () => {
    // A report subclassed in a host application names its root this way. Splitting
    // on "." alone answers "101, Culture=neutral, PublicKeyToken=null".
    const qualified =
      '<Item1 Ref="9" ControlType="DevExpress.XtraReports.UI.XRRichText, DevExpress.XtraReports.v20.1, ' +
      'Version=20.1.6.0, Culture=neutral, PublicKeyToken=b88d1754d700e49a" Name="rich1" />';
    const control = chunkRepx(wrap(detail(qualified))).find((c) => c.kind === 'control');
    expect(control?.controlType).toBe('XRRichText');
    expect(control?.caption).toBe('rich text in the detail band');
  });

  it('attributes a control to the outermost band, not to the sub-band holding it', () => {
    // Nine bands came back captioned "empty" with all 44 controls filed under "sub
    // band" before this. "in the sub band" locates nothing.
    const sub =
      '<SubBands><Item1 Ref="8" ControlType="SubBand" Name="SubBand1" HeightF="25">' +
      `<Controls>${label('Text="Total"')}</Controls></Item1></SubBands>`;
    const xml = wrap(
      `<Item2 Ref="2" ControlType="DetailBand" Name="Detail" HeightF="96">${sub}</Item2>`,
    );
    const chunks = chunkRepx(xml);

    expect(kinds(chunks)).toEqual(['DetailBand', 'XRLabel']);
    expect(chunks.find((c) => c.kind === 'control')?.band).toBe('DetailBand');
    expect(chunks[0].caption).toContain('containing 1 label');
  });

  it('chunks a cross-band control, which belongs to the report rather than a band', () => {
    const xml =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<XtraReportsLayoutSerializer Ref="0" ControlType="DevExpress.XtraReports.UI.XtraReport" Name="R">' +
      `<Bands>${detail(label('Text="A"'))}</Bands>` +
      '<CrossBandControls><Item1 Ref="30" ControlType="XRCrossBandBox" Name="box1" WidthF="2" />' +
      '</CrossBandControls></XtraReportsLayoutSerializer>';
    const box = chunkRepx(xml).find((c) => c.controlType === 'XRCrossBandBox');
    expect(box?.kind).toBe('control');
    expect(box?.band).toBe('');
    expect(box?.caption).toBe('cross band box in the report');
  });

  it('returns chunks in document order, not in the order they close', () => {
    const chunks = chunkRepx(wrap(detail(label('Text="A"'))));
    // The band opens first and closes last; reading order is what a caller expects.
    expect(kinds(chunks)).toEqual(['DetailBand', 'XRLabel']);
    expect(chunks[0].start).toBeLessThan(chunks[1].start);
  });

  it('carries the source name through, and defaults it to empty', () => {
    const xml = wrap(detail(label('Text="A"')));
    expect(chunkRepx(xml, 'Invoice.repx').every((c) => c.source === 'Invoice.repx')).toBe(true);
    expect(chunkRepx(xml).every((c) => c.source === '')).toBe(true);
  });
});

describe('redaction', () => {
  it('replaces every attribute it claims to, and leaves no original value behind', () => {
    for (const [name, placeholder] of Object.entries(REDACTIONS)) {
      const xml = wrap(detail(`<Item1 ControlType="XRLabel" ${name}="SECRET" />`));
      const control = chunkRepx(xml).find((c) => c.kind === 'control');
      expect(control?.xml, name).toContain(`${name}="${placeholder}"`);
      expect(control?.xml, name).not.toContain('SECRET');
    }
  });

  it('redacts Ref, because a copied one makes the loader discard content', () => {
    const chunks = chunkRepx(wrap(detail(label('Text="Total"'))));
    for (const chunk of chunks) {
      expect(chunk.xml).not.toMatch(/Ref="\d+"/);
      expect(chunk.xml).toContain('Ref="{ref}"');
    }
  });

  it('keeps everything that is style rather than content', () => {
    const kept = [
      'SizeF="120,20"',
      'LocationFloat="10,5"',
      'Font="Tahoma, 9pt, style=Bold"',
      'ForeColor="Navy"',
      'BackColor="255, 255, 255"',
      'TextAlignment="MiddleRight"',
      'TextFormatString="{0:c2}"',
      'Borders="Bottom"',
      'Padding="2,2,0,0,100"',
    ];
    const control = chunkRepx(wrap(detail(label(kept.join(' '))))).find((c) => c.kind === 'control');
    for (const attr of kept) expect(control?.xml, attr).toContain(attr);
  });

  it('counts what it replaced, and does not count an already-empty value', () => {
    const one = chunkRepx(wrap(detail('<Item1 ControlType="XRLabel" Text="Total" />')));
    expect(one.find((c) => c.kind === 'control')?.redacted).toBe(1);

    const empty = chunkRepx(wrap(detail('<Item1 ControlType="XRLabel" Text="" />')));
    expect(empty.find((c) => c.kind === 'control')?.redacted).toBe(0);
  });
});

describe('captions', () => {
  const captionOf = (xml: string, type: string) =>
    chunkRepx(xml).find((c) => c.controlType === type)?.caption ?? '';

  it('says what a band is, how tall, and what it holds', () => {
    const xml = wrap(
      detail(label('Text="A"') + label('Text="B"') + '<Item3 ControlType="XRLine" Name="line1" />'),
    );
    expect(captionOf(xml, 'DetailBand')).toBe('detail band, 96 tall, containing 2 labels, 1 line');
  });

  it('says so when a band is empty', () => {
    const xml = wrap('<Item1 Ref="1" ControlType="PageFooterBand" Name="PageFooter" HeightF="40" />');
    expect(captionOf(xml, 'PageFooterBand')).toBe('page footer band, 40 tall, empty');
  });

  it('describes a control in words an embedding can use', () => {
    const xml = wrap(
      detail(label('Text="Total" Font="Tahoma, 9pt, style=Bold" TextAlignment="MiddleRight"')),
    );
    expect(captionOf(xml, 'XRLabel')).toBe(
      'label in the detail band: Tahoma 9pt bold, middle right aligned',
    );
  });

  it('keeps the format string, because how money is shown is house style', () => {
    const xml = wrap(detail(label('Text="99" TextFormatString="{0:c2}"')));
    expect(captionOf(xml, 'XRLabel')).toContain('formatted {0:c2}');
  });

  it('carries no angle brackets and no redacted value', () => {
    // The caption is what gets embedded. XML embeds badly, and a placeholder in it
    // would be noise in every vector.
    const xml = wrap(detail(label('Text="Total" Font="Tahoma, 9pt"')));
    for (const chunk of chunkRepx(xml)) {
      expect(chunk.caption, chunk.controlType).not.toMatch(/[<>]/);
      expect(chunk.caption, chunk.controlType).not.toContain('{text}');
    }
  });

  it('falls back to naming the control when it has no appearance at all', () => {
    const xml = wrap(detail('<Item1 ControlType="XRPageBreak" Name="pageBreak1" />'));
    expect(captionOf(xml, 'XRPageBreak')).toBe('page break in the detail band');
  });
});
