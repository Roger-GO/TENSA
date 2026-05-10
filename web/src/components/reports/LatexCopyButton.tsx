// The pure helpers below (escapeLatexCell / pickColumnSpec /
// tableToLatex / tablesToLatex) co-export with the React component so
// the unit tests can import them without the plan needing a separate
// utility module. Disable the react-refresh hint locally — the plan's
// "Files to create" list intentionally keeps this consolidated.
/* eslint-disable react-refresh/only-export-components */
/**
 * LatexCopyButton (Unit 4 of the v2.0 plan).
 *
 * Renders a single ``<button>`` that, on click, serialises a list of
 * structured report tables into a LaTeX ``\begin{tabular}`` block and
 * writes the result to the clipboard via :func:`navigator.clipboard.writeText`.
 *
 * Styling choice: plain ``tabular`` (not ``booktabs``). The plan
 * explicitly notes "we can't assume booktabs is in user's preamble";
 * ``tabular`` is part of the LaTeX kernel and always available.
 *
 * Error handling: clipboard permission denial surfaces via the global
 * toast surface (`toast.error`). Per Unit 3 of the v2.0 polish plan
 * the inline ``role="alert"`` block has been retired in favour of a
 * single global toast surface that survives the unmount of this
 * component. The button stays enabled so the user can retry.
 *
 * Forward-compat: the underlying serialisation function
 * (``tablesToLatex``) is exported so future units can re-use it for
 * file export (e.g., a future "Save as .tex" affordance) without
 * duplicating the escaping rules.
 */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/lib/toast';

/**
 * Mirror of the substrate's ``ReportTable`` shape (defined in
 * ``server/src/andes_app/api/routes/reports.py``). Defined locally to
 * avoid coupling the LatexCopyButton to the generated OpenAPI types
 * — those regenerate out-of-band and the component should keep
 * working through the regen window.
 */
export interface LatexReportTable {
  title: string;
  headers: readonly string[];
  rows: readonly (readonly string[])[];
}

/**
 * Escape a single cell value for LaTeX consumption. Single-pass
 * substitution over the LaTeX kernel's 10 special characters.
 *
 * The 10 LaTeX special characters per ``LaTeX2e: An unofficial
 * reference manual`` §1.7: ``# $ % & _ { } ~ ^ \``. Tilde and caret
 * need ``\textasciitilde{}`` / ``\textasciicircum{}`` because the
 * bare ``\~`` and ``\^`` are accent macros. Backslash maps to
 * ``\textbackslash{}``.
 *
 * Why single-pass: a chained ``.replace()`` would risk re-escaping
 * braces emitted by the backslash replacement (``\textbackslash{}``
 * contains ``{}`` itself). The single regex + lookup map sees each
 * source character once.
 */
export function escapeLatexCell(value: string): string {
  const escapes: Record<string, string> = {
    '\\': '\\textbackslash{}',
    '~': '\\textasciitilde{}',
    '^': '\\textasciicircum{}',
    '&': '\\&',
    '%': '\\%',
    $: '\\$',
    '#': '\\#',
    _: '\\_',
    '{': '\\{',
    '}': '\\}',
  };
  return value.replace(/[\\~^&%$#_{}]/g, (m) => escapes[m]!);
}

/**
 * Heuristic: is a cell value numeric? Used to pick column alignment
 * (``r`` for numeric, ``l`` for text). The heuristic accepts integers,
 * decimals, scientific notation, and a leading sign — which is what
 * the substrate's report rows actually contain.
 */
function isNumericCell(value: string): boolean {
  if (value.length === 0) return false;
  return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value.trim());
}

/**
 * Compute the column-spec string (``{lrrr}``) by inspecting the
 * majority cell type per column. A column is numeric if more than
 * half of its non-empty cells parse as numbers; otherwise it's text.
 *
 * Pure over the table data — used both by ``tableToLatex`` and the
 * unit tests so the heuristic is testable in isolation.
 */
export function pickColumnSpec(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const result: string[] = [];
  for (let c = 0; c < headers.length; c++) {
    let numeric = 0;
    let total = 0;
    for (const row of rows) {
      const cell = (row[c] ?? '').trim();
      if (cell.length === 0) continue;
      total += 1;
      if (isNumericCell(cell)) numeric += 1;
    }
    // Default first column to ``l`` (label / name) if there's no
    // numeric data to disambiguate — matches the plan's example
    // ``{lrrr}`` shape.
    if (total === 0) {
      result.push(c === 0 ? 'l' : 'r');
    } else if (numeric * 2 > total) {
      result.push('r');
    } else {
      result.push('l');
    }
  }
  return result.join('');
}

/**
 * Serialise ONE table to a ``\begin{tabular}{...} ... \end{tabular}``
 * block. The block is wrapped in a ``% Title`` comment so the
 * destination ``.tex`` file is self-documenting after paste.
 */
export function tableToLatex(table: LatexReportTable): string {
  const colSpec = pickColumnSpec(table.headers, table.rows);
  const headerRow = table.headers.map(escapeLatexCell).join(' & ');
  const dataRows = table.rows.map((row) => row.map(escapeLatexCell).join(' & ') + ' \\\\');
  const body = [
    `% ${table.title}`,
    `\\begin{tabular}{${colSpec}}`,
    `\\hline`,
    headerRow + ' \\\\',
    `\\hline`,
    ...dataRows,
    `\\hline`,
    `\\end{tabular}`,
  ];
  return body.join('\n');
}

/**
 * Serialise a list of tables to a single LaTeX string. Tables are
 * separated by a blank line so the destination file's diff stays
 * readable. Empty list returns the empty string.
 */
export function tablesToLatex(tables: readonly LatexReportTable[]): string {
  if (tables.length === 0) return '';
  return tables.map(tableToLatex).join('\n\n') + '\n';
}

export interface LatexCopyButtonProps {
  /** Tables to serialise on click. */
  tables: readonly LatexReportTable[];
  /**
   * Optional test-id suffix — appended to the base ``latex-copy-button``
   * data-testid so the same component can be mounted twice on a page
   * (one per routine tab) without colliding selectors.
   */
  testIdSuffix?: string;
  /** Optional disabled override (e.g., when no tables to copy). */
  disabled?: boolean;
}

export function LatexCopyButton({ tables, testIdSuffix, disabled }: LatexCopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const isEmpty = tables.length === 0;
  const handleClick = async () => {
    setCopied(false);
    const payload = tablesToLatex(tables);
    if (payload.length === 0) {
      toast.warning('Nothing to copy: this report has no structured tables.');
      return;
    }
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      toast.error(
        'Clipboard API unavailable in this browser — copy the text manually from the report body.',
      );
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      setCopied(true);
      toast.success('Copied LaTeX tables to clipboard.');
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown clipboard error';
      toast.error('Copy failed.', { description: detail });
    }
  };

  const baseTestId = 'latex-copy-button';
  const testId = testIdSuffix ? `${baseTestId}-${testIdSuffix}` : baseTestId;

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled || isEmpty}
      onClick={() => void handleClick()}
      data-testid={testId}
    >
      {copied ? 'Copied!' : 'Copy as LaTeX'}
    </Button>
  );
}
