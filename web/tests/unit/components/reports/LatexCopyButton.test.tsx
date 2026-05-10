/**
 * Tests for `<LatexCopyButton />` and the underlying serialisation
 * helpers (Unit 4 of the v2.0 plan).
 *
 * Coverage:
 *
 * - Pure function: cell escape covers the LaTeX special characters.
 * - Pure function: column-spec heuristic picks ``r`` for numeric and
 *   ``l`` for text columns.
 * - Pure function: ``tablesToLatex`` emits a paste-ready
 *   ``\begin{tabular}`` block for each table.
 * - Component: clicking the button writes the serialised LaTeX to the
 *   clipboard via ``navigator.clipboard.writeText`` and flips the
 *   label to "Copied!".
 * - Component: clipboard permission denial surfaces inline as a
 *   ``role="alert"`` block (no toast).
 * - Component: empty tables disable the button so users don't paste
 *   nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();
const toastWarningMock = vi.fn();

vi.mock('@/lib/toast', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
    warning: (...args: unknown[]) => toastWarningMock(...args),
    info: vi.fn(),
    dismiss: vi.fn(),
  },
}));

import {
  LatexCopyButton,
  escapeLatexCell,
  pickColumnSpec,
  tableToLatex,
  tablesToLatex,
  type LatexReportTable,
} from '@/components/reports/LatexCopyButton';

const writeTextSpy = vi.fn<(text: string) => Promise<void>>();
const originalClipboard = (globalThis.navigator as Navigator | undefined)?.clipboard;

beforeEach(() => {
  writeTextSpy.mockReset();
  writeTextSpy.mockResolvedValue(undefined);
  toastSuccessMock.mockReset();
  toastErrorMock.mockReset();
  toastWarningMock.mockReset();
  // jsdom doesn't ship a navigator.clipboard; install the stub.
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: { writeText: writeTextSpy },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  if (originalClipboard !== undefined) {
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: originalClipboard,
      configurable: true,
      writable: true,
    });
  } else {
    // Best-effort cleanup; suppress if jsdom locks the property.
    try {
      // @ts-expect-error — intentional teardown
      delete (globalThis.navigator as Navigator & { clipboard?: unknown }).clipboard;
    } catch {
      // ignore
    }
  }
  cleanup();
});

const SAMPLE_BUS_TABLE: LatexReportTable = {
  title: 'BUS DATA',
  headers: ['Bus Name', 'Vm(pu)', 'Va(rad.)'],
  rows: [
    ['BUS1', '1.03', '0.0'],
    ['BUS2', '1.04', '-0.030'],
  ],
};

const SAMPLE_LINE_TABLE: LatexReportTable = {
  title: 'LINE DATA',
  headers: ['Line Name', 'Fr. Bus', 'To Bus'],
  rows: [['Line_1', '1', '2']],
};

// ---- escapeLatexCell -----------------------------------------------------

describe('escapeLatexCell', () => {
  it('escapes the 7 minor special characters', () => {
    expect(escapeLatexCell('a&b%c$d#e_f{g}h')).toBe('a\\&b\\%c\\$d\\#e\\_f\\{g\\}h');
  });

  it('escapes backslash before any other replacement so escapes are not double-applied', () => {
    expect(escapeLatexCell('\\$')).toBe('\\textbackslash{}\\$');
  });

  it('escapes tilde and caret via the textascii macros', () => {
    expect(escapeLatexCell('~^')).toBe('\\textasciitilde{}\\textasciicircum{}');
  });

  it('passes plain text through unchanged', () => {
    expect(escapeLatexCell('Bus_1')).toBe('Bus\\_1');
    expect(escapeLatexCell('1.03')).toBe('1.03');
    expect(escapeLatexCell('-7.95e-14')).toBe('-7.95e-14');
  });
});

// ---- pickColumnSpec ------------------------------------------------------

describe('pickColumnSpec', () => {
  it('picks "l" for the first text column and "r" for numeric columns', () => {
    expect(pickColumnSpec(SAMPLE_BUS_TABLE.headers, SAMPLE_BUS_TABLE.rows)).toBe('lrr');
  });

  it('returns all "r" when every column is numeric', () => {
    expect(
      pickColumnSpec(
        ['a', 'b', 'c'],
        [
          ['1', '2', '3'],
          ['4', '5', '6'],
        ],
      ),
    ).toBe('rrr');
  });

  it('returns "l" for an all-text column even past the first', () => {
    expect(
      pickColumnSpec(
        ['name', 'kind'],
        [
          ['BUS1', 'PV'],
          ['BUS2', 'Slack'],
        ],
      ),
    ).toBe('ll');
  });

  it('handles empty rows by defaulting first column to "l" and the rest to "r"', () => {
    expect(pickColumnSpec(['a', 'b', 'c'], [])).toBe('lrr');
  });

  it('treats scientific notation as numeric', () => {
    expect(pickColumnSpec(['name', 'val'], [['x', '7.95e-14']])).toBe('lr');
  });
});

// ---- tableToLatex --------------------------------------------------------

describe('tableToLatex', () => {
  it('produces a paste-ready tabular block with hlines and a comment header', () => {
    const out = tableToLatex(SAMPLE_BUS_TABLE);
    expect(out).toContain('% BUS DATA');
    expect(out).toContain('\\begin{tabular}{lrr}');
    expect(out).toContain('\\hline');
    expect(out).toContain('Bus Name & Vm(pu) & Va(rad.) \\\\');
    expect(out).toContain('BUS1 & 1.03 & 0.0 \\\\');
    expect(out).toContain('BUS2 & 1.04 & -0.030 \\\\');
    expect(out).toContain('\\end{tabular}');
  });

  it('escapes special characters in cell values', () => {
    const out = tableToLatex({
      title: 'X',
      headers: ['name', '%share'],
      rows: [['A_1', '50%']],
    });
    expect(out).toContain('A\\_1');
    expect(out).toContain('50\\%');
    // Header is escaped too.
    expect(out).toContain('\\%share');
  });
});

describe('tablesToLatex', () => {
  it('joins multiple tables with a blank line and trailing newline', () => {
    const out = tablesToLatex([SAMPLE_BUS_TABLE, SAMPLE_LINE_TABLE]);
    expect(out).toContain('% BUS DATA');
    expect(out).toContain('% LINE DATA');
    // Blank line between tables.
    expect(out).toMatch(/\\end\{tabular\}\n\n%/);
    // Trailing newline.
    expect(out.endsWith('\n')).toBe(true);
  });

  it('returns the empty string for an empty tables list', () => {
    expect(tablesToLatex([])).toBe('');
  });
});

// ---- <LatexCopyButton /> -------------------------------------------------

describe('<LatexCopyButton />', () => {
  it('writes a non-empty LaTeX block to the clipboard on click', async () => {
    const user = userEvent.setup();
    // user-event v14 attaches its own ``navigator.clipboard`` at
    // ``setup()`` time, which would override the beforeEach stub.
    // Re-install the spy AFTER setup so the click path lands on it.
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText: writeTextSpy },
      configurable: true,
      writable: true,
    });
    render(<LatexCopyButton tables={[SAMPLE_BUS_TABLE]} />);
    const btn = screen.getByTestId('latex-copy-button');
    await user.click(btn);
    await waitFor(() => expect(writeTextSpy).toHaveBeenCalledTimes(1));
    const payload = writeTextSpy.mock.calls[0]![0];
    expect(payload).toContain('\\begin{tabular}{lrr}');
    expect(payload).toContain('BUS1 & 1.03 & 0.0 \\\\');
  });

  it('flips the button label to "Copied!" after a successful write', async () => {
    const user = userEvent.setup();
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText: writeTextSpy },
      configurable: true,
      writable: true,
    });
    render(<LatexCopyButton tables={[SAMPLE_BUS_TABLE]} />);
    await user.click(screen.getByTestId('latex-copy-button'));
    await waitFor(() =>
      expect(screen.getByTestId('latex-copy-button')).toHaveTextContent('Copied!'),
    );
  });

  it('appends the testIdSuffix to the data-testid so two instances do not collide', () => {
    render(<LatexCopyButton tables={[SAMPLE_BUS_TABLE]} testIdSuffix="pflow" />);
    expect(screen.getByTestId('latex-copy-button-pflow')).toBeInTheDocument();
  });

  it('disables the button when no tables are provided', () => {
    render(<LatexCopyButton tables={[]} />);
    expect(screen.getByTestId('latex-copy-button')).toBeDisabled();
  });

  it('surfaces clipboard permission denial via toast.error (no inline alert)', async () => {
    const user = userEvent.setup();
    // Replace the persistent resolution with a persistent rejection so
    // the writeText path always throws — matches the real "permission
    // denied" failure mode where every retry would also fail.
    writeTextSpy.mockReset();
    writeTextSpy.mockRejectedValue(new Error('NotAllowedError: write denied'));
    // user-event v14 attaches its own clipboard at setup() — re-install
    // ours so the failing writeText is the one the button sees.
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText: writeTextSpy },
      configurable: true,
      writable: true,
    });
    render(<LatexCopyButton tables={[SAMPLE_BUS_TABLE]} />);
    await user.click(screen.getByTestId('latex-copy-button'));
    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        'Copy failed.',
        expect.objectContaining({ description: 'NotAllowedError: write denied' }),
      ),
    );
    // Button stays enabled so the user can retry.
    expect(screen.getByTestId('latex-copy-button')).toBeEnabled();
    // Inline role=alert block was retired in Unit 3 of the v2.0 polish plan.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not call writeText when the tables list is empty', async () => {
    const user = userEvent.setup();
    render(<LatexCopyButton tables={[]} />);
    const btn = screen.getByTestId('latex-copy-button');
    // Disabled buttons swallow the click; user-event's pointer-events
    // simulation respects that, so this asserts the wired-up disabled
    // state.
    await user.click(btn).catch(() => undefined);
    expect(writeTextSpy).not.toHaveBeenCalled();
  });

  it('fires toast.error when navigator.clipboard is unavailable', async () => {
    const user = userEvent.setup();
    // user-event v14 sets navigator.clipboard at setup() — clear it
    // AFTER setup so the button's check trips on undefined.
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    render(<LatexCopyButton tables={[SAMPLE_BUS_TABLE]} />);
    await user.click(screen.getByTestId('latex-copy-button'));
    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        expect.stringMatching(/clipboard api unavailable/i),
      ),
    );
  });

  it('happy path also fires toast.success', async () => {
    const user = userEvent.setup();
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText: writeTextSpy },
      configurable: true,
      writable: true,
    });
    render(<LatexCopyButton tables={[SAMPLE_BUS_TABLE]} />);
    await user.click(screen.getByTestId('latex-copy-button'));
    await waitFor(() => expect(writeTextSpy).toHaveBeenCalled());
    await waitFor(() =>
      expect(toastSuccessMock).toHaveBeenCalledWith('Copied LaTeX tables to clipboard.'),
    );
  });
});
