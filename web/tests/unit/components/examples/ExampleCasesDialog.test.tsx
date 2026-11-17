/**
 * ExampleCasesDialog: the example cases of the catalog, to add to the workspace and open.
 *
 * The real hooks run against a stand-in for the server (`fetch` answers `GET /examples` from
 * a list a test can change, and an add moves a case into the workspace), so what is held is
 * the whole round trip: the cards grouped by what the case supports, Add then Added and Open,
 * the answers of the server to an add (a warning, a conflict, a refusal), Open handing the
 * file to `useOpenCase`, Cite copying the references, the filter, the reasons a button is
 * greyed out, and where the keyboard focus is when the dialog opens, after an add and when
 * it closes. `useOpenCase` is replaced by a stand-in that records what it was asked to open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ExampleCasesDialog } from '@/components/examples/ExampleCasesDialog';
import { ExampleCasesButton } from '@/components/examples/ExampleCasesButton';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { ExampleListEntry } from '@/api/types';
import { useCaseStore } from '@/store/case';
import { useExampleCasesStore } from '@/store/exampleCases';
import { useSessionStore } from '@/store/session';
import { toast } from '@/lib/toast';
import { makeCatalog, makeExample } from '../../helpers/exampleCatalog';

const openCaseMock = vi.fn();
let loadPending = false;
vi.mock('@/lib/openCase', async () => {
  const actual = await vi.importActual<typeof import('@/lib/openCase')>('@/lib/openCase');
  return {
    ...actual,
    useOpenCase: () => ({ openCase: openCaseMock, isPending: loadPending }),
  };
});

// ---- a stand-in for the server --------------------------------------------------------

interface FakeServer {
  examples: ExampleListEntry[];
  /** What the next add answers, or `null` to add the case and say so. */
  addAnswer: (() => Response) | null;
  listFails: boolean;
}

let server: FakeServer;
const requests: string[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function problem(status: number, detail: string): Response {
  return jsonResponse({ type: 'about:blank', title: `HTTP ${status}`, status, detail }, status);
}

function fakeFetch(input: unknown, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const method = init?.method ?? 'GET';
  requests.push(`${method} ${url}`);
  if (method === 'GET' && url === '/api/examples') {
    return Promise.resolve(
      server.listFails
        ? problem(500, 'the catalog is damaged')
        : jsonResponse({ examples: server.examples }),
    );
  }
  const add = /^\/api\/examples\/([^/?]+)\/add/.exec(url);
  if (method === 'POST' && add !== null) {
    if (server.addAnswer !== null) return Promise.resolve(server.addAnswer());
    const entry = server.examples.find((e) => e.id === add[1]);
    if (entry === undefined) return Promise.resolve(problem(404, 'no such example'));
    const name = entry.provenance.path!.split('/').pop()!;
    server.examples = server.examples.map((e) =>
      e.id === entry.id ? { ...e, in_workspace: true } : e,
    );
    return Promise.resolve(
      jsonResponse(
        {
          id: entry.id,
          primary: name,
          files: [{ name, size_bytes: 10, replaced: false }],
          warnings: [],
          sources_file: 'EXAMPLE-SOURCES.md',
        },
        201,
      ),
    );
  }
  return Promise.resolve(problem(404, `unexpected ${method} ${url}`));
}

function renderDialog() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ExampleCasesButton />
      <ExampleCasesDialog />
    </QueryClientProvider>,
  );
}

/** The dialog, opened by the button as a user opens it, with its list loaded. */
async function openDialog(waitForCard = 'ieee14') {
  const user = userEvent.setup();
  renderDialog();
  await user.click(screen.getByTestId('example-cases-open'));
  await screen.findByTestId(`example-card-${waitForCard}`);
  return user;
}

const card = (id: string) => within(screen.getByTestId(`example-card-${id}`));

beforeEach(() => {
  server = { examples: makeCatalog(), addAnswer: null, listFails: false };
  requests.length = 0;
  loadPending = false;
  openCaseMock.mockReset();
  vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch').mockImplementation(
    fakeFetch as typeof fetch,
  );
  useExampleCasesStore.setState({ dialogOpen: false });
  useSessionStore.setState({ sessionId: parseSessionId('s1') });
  useCaseStore.setState({ selection: null, loadingPath: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the Example cases dialog', () => {
  it('draws nothing until it is opened, and reads the catalog then', async () => {
    renderDialog();
    expect(screen.queryByTestId('example-cases-dialog')).not.toBeInTheDocument();
    expect(requests).toEqual([]);
    await userEvent.setup().click(screen.getByRole('button', { name: /example cases/i }));
    expect(await screen.findByRole('dialog', { name: 'Example cases' })).toBeInTheDocument();
    await screen.findByTestId('example-card-ieee14');
    expect(requests).toEqual(['GET /api/examples']);
  });

  it('groups the cases by what they support, each with its size, analyses and purpose', async () => {
    await openDialog();
    const dynamic = within(screen.getByTestId('example-group-dynamic'));
    const steady = within(screen.getByTestId('example-group-steady-state'));
    expect(dynamic.getByRole('heading', { name: 'Dynamic cases' })).toBeInTheDocument();
    expect(steady.getByRole('heading', { name: 'Steady-state cases' })).toBeInTheDocument();
    expect(dynamic.getByTestId('example-card-ieee14')).toBeInTheDocument();
    expect(dynamic.getByTestId('example-card-texas-dynamic')).toBeInTheDocument();
    expect(steady.getByTestId('example-card-wscc9')).toBeInTheDocument();

    expect(screen.getByTestId('example-size-ieee14')).toHaveTextContent('14 buses, 5 generators');
    for (const analysis of ['pf', 'tds', 'eig']) {
      expect(screen.getByTestId(`example-analysis-ieee14-${analysis}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('example-analysis-wscc9-pf')).toHaveTextContent('Power flow');
    expect(screen.queryByTestId('example-analysis-wscc9-tds')).not.toBeInTheDocument();
    expect(card('ieee14').getByText(/IEEE 14-bus system with machines/)).toBeInTheDocument();
    expect(screen.getByTestId('example-cases-count')).toHaveTextContent('3 cases');
  });

  it('links the source and the licence in a new tab, without handing over the window', async () => {
    await openDialog();
    const source = screen.getByTestId('example-source-ieee14');
    expect(source).toHaveAttribute('href', expect.stringContaining('github.com/CURENT/andes'));
    expect(source).toHaveTextContent('ANDES 2.0.0');
    const licence = screen.getByTestId('example-licence-ieee14');
    expect(licence).toHaveTextContent('GPL-3.0-or-later');
    for (const link of [source, licence]) {
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(link).toHaveTextContent(/opens in a new tab/);
    }
    // A licence with no address is text, not a dead link.
    expect(screen.getByTestId('example-licence-wscc9').tagName).toBe('SPAN');
  });

  it('shows a case that is only links with an Open source page link, and nothing to add', async () => {
    await openDialog();
    const texas = card('texas-dynamic');
    const link = texas.getByRole('link', { name: /Open source page/ });
    expect(link).toHaveAttribute('href', 'https://electricgrids.engr.tamu.edu/');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(texas.getByText('Link only')).toBeInTheDocument();
    expect(texas.getByText(/Add files/)).toBeInTheDocument();
    expect(texas.queryByRole('button', { name: /Add to workspace/ })).not.toBeInTheDocument();
    expect(texas.queryByRole('button', { name: /^Open/ })).not.toBeInTheDocument();
    expect(texas.queryByRole('button', { name: /^Cite/ })).not.toBeInTheDocument();
  });

  it('names the file a case is in the workspace as, with the files it is opened with', async () => {
    server.examples = [
      ...server.examples,
      makeExample({
        id: 'pegase89',
        title: 'PEGASE 89-bus',
        provenance: {
          kind: 'bundled',
          path: 'pegase/case89.raw',
          source_url: 'https://example.org/p',
        },
        extra_files: [{ path: 'pegase/case89.dyr', sha256: 'a'.repeat(64), role: 'dynamic data' }],
      }),
    ];
    await openDialog();
    expect(screen.getByTestId('example-file-ieee14')).toHaveTextContent('ieee14_full.xlsx');
    expect(screen.getByTestId('example-file-wscc9')).toHaveTextContent('wscc9.xlsx');
    expect(screen.getByTestId('example-file-pegase89')).toHaveTextContent('case89.raw, case89.dyr');
    // A case that is only links has no file.
    expect(screen.queryByTestId('example-file-texas-dynamic')).not.toBeInTheDocument();
  });

  it('does not make a link of an address that is not http or https', async () => {
    server.examples = [
      makeExample({
        provenance: {
          kind: 'andes',
          path: 'ieee14/ieee14_full.xlsx',
          release: 'ANDES 2.0.0',
          source_url: 'javascript:alert(1)',
        },
        licence: { name: 'GPL', url: 'data:text/html,x' },
      }),
    ];
    await openDialog();
    expect(screen.getByTestId('example-source-ieee14').tagName).toBe('SPAN');
    expect(screen.getByTestId('example-licence-ieee14').tagName).toBe('SPAN');
    expect(card('ieee14').queryByRole('link', { name: /ANDES 2.0.0/ })).toBeNull();
  });

  it('keeps the caveats of a case one disclosure away', async () => {
    await openDialog();
    const details = screen.getByTestId('example-details-ieee14');
    expect(details).not.toHaveAttribute('open');
    expect(within(details).getByText('Caveats, changes and checks')).toBeInTheDocument();
    expect(details).toHaveTextContent('has not been compared with the UW archive');
    // A case with nothing to say has no disclosure.
    expect(screen.queryByTestId('example-details-wscc9')).not.toBeInTheDocument();
  });
});

describe('adding a case', () => {
  it('offers Add to a case that is not in the workspace and Open to one that is', async () => {
    server.examples = server.examples.map((e) =>
      e.id === 'ieee14' ? { ...e, in_workspace: true } : e,
    );
    await openDialog();
    expect(card('ieee14').getByTestId('example-added-ieee14')).toHaveTextContent('Added');
    expect(card('ieee14').getByRole('button', { name: /^Open/ })).toBeEnabled();
    expect(card('ieee14').queryByRole('button', { name: /Add to workspace/ })).toBeNull();
    expect(card('wscc9').getByRole('button', { name: /^Add to workspace/ })).toBeEnabled();
    expect(card('wscc9').queryByTestId('example-added-wscc9')).not.toBeInTheDocument();
    expect(card('wscc9').queryByRole('button', { name: /^Open/ })).toBeNull();
  });

  it('adds the case, says so, and puts the keyboard focus on its Open button', async () => {
    const success = vi.spyOn(toast, 'success');
    const user = await openDialog();
    await user.click(card('wscc9').getByRole('button', { name: /^Add to workspace/ }));
    await screen.findByTestId('example-added-wscc9');

    expect(requests).toContain('POST /api/examples/wscc9/add?overwrite=false');
    // The list was read again, which is what turned the card to Added.
    expect(requests.filter((r) => r === 'GET /api/examples').length).toBeGreaterThanOrEqual(2);
    expect(success).toHaveBeenCalledWith(
      'Added wscc9.xlsx to the workspace',
      expect.objectContaining({ description: expect.stringContaining('EXAMPLE-SOURCES.md') }),
    );
    const open = card('wscc9').getByRole('button', { name: /^Open/ });
    await waitFor(() => expect(open).toHaveFocus());
    expect(card('wscc9').queryByRole('button', { name: /Add to workspace/ })).toBeNull();
  });

  it('does not offer Add a second time while the list is read again', async () => {
    const user = await openDialog();
    // The list is slow to come back after the add: the card has to say Added without it.
    let release: (r: Response) => void = () => undefined;
    vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch').mockImplementation(
      (input, init) =>
        String(input) === '/api/examples' && (init?.method ?? 'GET') === 'GET'
          ? new Promise<Response>((resolve) => (release = resolve))
          : fakeFetch(input, init),
    );
    await user.click(card('wscc9').getByRole('button', { name: /^Add to workspace/ }));
    await screen.findByTestId('example-added-wscc9');
    expect(card('wscc9').queryByRole('button', { name: /Add to workspace/ })).toBeNull();
    expect(card('wscc9').getByRole('button', { name: /^Open/ })).toBeEnabled();
    // When the list does come back it agrees, and the card stays as it is.
    release(jsonResponse({ examples: server.examples }));
    await waitFor(() => expect(requests).toContain('POST /api/examples/wscc9/add?overwrite=false'));
    expect(screen.getByTestId('example-added-wscc9')).toBeInTheDocument();
  });

  it('can be done from the keyboard alone: Enter on Add, then Enter on Open', async () => {
    const user = await openDialog();
    card('wscc9')
      .getByRole('button', { name: /^Add to workspace/ })
      .focus();
    await user.keyboard('{Enter}');
    const open = await within(screen.getByTestId('example-card-wscc9')).findByRole('button', {
      name: /^Open/,
    });
    await waitFor(() => expect(open).toHaveFocus());
    await user.keyboard('{Enter}');
    expect(openCaseMock).toHaveBeenCalledWith('wscc9.xlsx', []);
  });

  it('says what the server warned about the file, in the card and in a notice', async () => {
    const warning = vi.spyOn(toast, 'warning');
    server.addAnswer = () =>
      jsonResponse(
        {
          id: 'wscc9',
          primary: 'wscc9.xlsx',
          files: [{ name: 'wscc9.xlsx', size_bytes: 10, replaced: false }],
          warnings: ['The ANDES file is not the one this catalog was written against.'],
          sources_file: 'EXAMPLE-SOURCES.md',
        },
        201,
      );
    const user = await openDialog();
    await user.click(card('wscc9').getByRole('button', { name: /^Add to workspace/ }));
    const note = await screen.findByTestId('example-note-wscc9');
    expect(note).toHaveAttribute('data-kind', 'warning');
    expect(note).toHaveAttribute('role', 'status');
    expect(note).toHaveTextContent('not the one this catalog was written against');
    expect(warning).toHaveBeenCalledWith(
      'Added wscc9.xlsx to the workspace',
      expect.objectContaining({
        description: expect.stringContaining('not the one this catalog was written against'),
      }),
    );
  });

  it('says a file that is there already is there, and reads the list again so it shows as added', async () => {
    server.addAnswer = () => {
      // Another tab put it there: the next read of the list says so.
      server.examples = server.examples.map((e) =>
        e.id === 'wscc9' ? { ...e, in_workspace: true } : e,
      );
      return problem(409, "'wscc9.xlsx' already exists; send overwrite=true to replace it");
    };
    const user = await openDialog();
    await user.click(card('wscc9').getByRole('button', { name: /^Add to workspace/ }));
    expect(await screen.findByTestId('example-added-wscc9')).toBeInTheDocument();
    expect(screen.getByTestId('example-note-wscc9')).toHaveTextContent(
      'wscc9.xlsx is already in the workspace.',
    );
    expect(screen.getByTestId('example-note-wscc9')).toHaveAttribute('role', 'status');
  });

  it('shows a refusal as an alert in the card and leaves the case addable', async () => {
    server.addAnswer = () => problem(500, 'No space left on device');
    const user = await openDialog();
    await user.click(card('wscc9').getByRole('button', { name: /^Add to workspace/ }));
    const alert = await within(screen.getByTestId('example-card-wscc9')).findByRole('alert');
    expect(alert).toHaveTextContent('Could not add this case: No space left on device');
    expect(card('wscc9').getByRole('button', { name: /^Add to workspace/ })).toBeEnabled();
    expect(screen.queryByTestId('example-added-wscc9')).not.toBeInTheDocument();
  });

  it('greys Add out with the reason when the installed ANDES lacks the case', async () => {
    server.examples = server.examples.map((e) =>
      e.id === 'wscc9' ? { ...e, available: false } : e,
    );
    await openDialog();
    expect(card('wscc9').getByRole('button', { name: /^Add to workspace/ })).toBeDisabled();
    expect(screen.getByTestId('example-add-blocked-wscc9')).toHaveTextContent(
      'The installed ANDES does not have this case.',
    );
  });

  it('says a bundled file is missing from the installation, not from ANDES', async () => {
    server.examples = [
      makeExample({
        id: 'rts24',
        provenance: { kind: 'bundled', path: 'rts/rts24.m' },
        available: false,
      }),
    ];
    await openDialog('rts24');
    expect(screen.getByTestId('example-add-blocked-rts24')).toHaveTextContent(
      'This installation of TENSA is missing the file of this case.',
    );
  });
});

describe('opening a case', () => {
  beforeEach(() => {
    server.examples = server.examples.map((e) =>
      e.id === 'ieee14' ? { ...e, in_workspace: true } : e,
    );
  });

  it('hands the file to the loader and closes the dialog, so the diagram is what is shown', async () => {
    const user = await openDialog();
    await user.click(card('ieee14').getByRole('button', { name: /^Open/ }));
    expect(openCaseMock).toHaveBeenCalledWith('ieee14_full.xlsx', []);
    expect(useExampleCasesStore.getState().dialogOpen).toBe(false);
    await waitFor(() => expect(screen.queryByTestId('example-cases-dialog')).toBeNull());
  });

  it('opens a case with the files it is loaded with', async () => {
    server.examples = [
      makeExample({
        id: 'pegase89',
        provenance: { kind: 'bundled', path: 'pegase/case89.raw' },
        extra_files: [{ path: 'pegase/case89.dyr', sha256: 'a'.repeat(64), role: 'dynamic data' }],
        in_workspace: true,
      }),
    ];
    const user = await openDialog('pegase89');
    await user.click(card('pegase89').getByRole('button', { name: /^Open/ }));
    expect(openCaseMock).toHaveBeenCalledWith('case89.raw', ['case89.dyr']);
  });

  it('says Open now, with no button, for the case that is open', async () => {
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('ieee14_full.xlsx'), addfiles: [] },
    });
    await openDialog();
    expect(screen.getByTestId('example-open-now-ieee14')).toHaveTextContent('Open now');
    expect(card('ieee14').queryByRole('button', { name: /^Open/ })).toBeNull();
  });

  it('greys Open out and says why while there is no session', async () => {
    useSessionStore.setState({ sessionId: null });
    await openDialog();
    expect(card('ieee14').getByRole('button', { name: /^Open/ })).toBeDisabled();
    expect(screen.getByTestId('example-open-blocked-ieee14')).toHaveTextContent(
      'Waiting for the server to start a session',
    );
  });

  it('greys Open out and says why while another case is loading', async () => {
    useCaseStore.setState({ loadingPath: parseWorkspacePath('kundur_full.xlsx') });
    await openDialog();
    expect(card('ieee14').getByRole('button', { name: /^Open/ })).toBeDisabled();
    expect(screen.getByTestId('example-open-blocked-ieee14')).toHaveTextContent(
      'Another case is loading.',
    );
  });
});

describe('citing a case', () => {
  const writeText = vi.fn();
  /**
   * The browser's clipboard, as the test wants it. A stand-in for it is set after the dialog is
   * open: `userEvent.setup()` puts a clipboard of its own on `navigator`, which a stand-in set
   * earlier would lose to.
   */
  const stubClipboard = (value: unknown) =>
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value });
  beforeEach(() => {
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
  });

  it('opens the references from Cite, as a disclosure', async () => {
    const user = await openDialog();
    const cite = card('ieee14').getByRole('button', { name: /^Cite/ });
    expect(cite).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('example-cite-panel-ieee14')).not.toBeVisible();
    await user.click(cite);
    expect(cite).toHaveAttribute('aria-expanded', 'true');
    const panel = within(screen.getByTestId('example-cite-panel-ieee14'));
    expect(panel.getByText(/IEEE 14 Bus Test Case, University of Washington/)).toBeVisible();
    expect(panel.getByText(/H. Cui, F. Li and K. Tomsovic/)).toBeVisible();
    // The licence's credit sits with the references.
    expect(panel.getByText(/ANDES asks that research that uses it cite its paper/)).toBeVisible();
    // A reference with an address links to it in a new tab.
    const doi = panel.getByRole('link', { name: /doi\.org/ });
    expect(doi).toHaveAttribute('href', 'https://doi.org/10.1109/TPWRS.2020.3017019');
    expect(doi).toHaveAttribute('rel', 'noopener noreferrer');
    await user.click(cite);
    expect(cite).toHaveAttribute('aria-expanded', 'false');
  });

  it('copies every reference of the case as text, and says it did', async () => {
    const success = vi.spyOn(toast, 'success');
    const user = await openDialog();
    stubClipboard({ writeText });
    await user.click(card('ieee14').getByRole('button', { name: /^Cite/ }));
    await user.click(card('ieee14').getByRole('button', { name: /^Copy as text/ }));
    expect(writeText).toHaveBeenCalledWith(
      'IEEE 14 Bus Test Case, University of Washington.\n\n' +
        'H. Cui, F. Li and K. Tomsovic, ANDES, doi:10.1109/TPWRS.2020.3017019.',
    );
    expect(success).toHaveBeenCalledWith(
      'Copied the citation of IEEE 14-bus, with machines and controls',
      expect.anything(),
    );
  });

  it('says in the panel what was copied, until the panel is closed or a copy is refused', async () => {
    const user = await openDialog();
    stubClipboard({ writeText });
    const cite = card('ieee14').getByRole('button', { name: /^Cite/ });
    await user.click(cite);
    const status = screen.getByTestId('example-copy-status-ieee14');
    // A region that is in the page before anything is said, so a screen reader hears it.
    expect(status).toHaveAttribute('role', 'status');
    expect(status).toHaveTextContent('');
    await user.click(card('ieee14').getByRole('button', { name: /^Copy as text/ }));
    expect(status).toHaveTextContent('Copied as text.');
    await user.click(card('ieee14').getByRole('button', { name: /^Copy as BibTeX/ }));
    expect(status).toHaveTextContent('Copied as BibTeX.');
    writeText.mockRejectedValue(new Error('denied'));
    await user.click(card('ieee14').getByRole('button', { name: /^Copy as text/ }));
    expect(status).toHaveTextContent('The browser did not let the citation be copied.');
    expect(status).toHaveTextContent('copy it by hand');
    writeText.mockResolvedValue(undefined);
    await user.click(card('ieee14').getByRole('button', { name: /^Copy as text/ }));
    expect(status).toHaveTextContent('Copied as text.');
    // Closed and opened again, the panel does not claim a copy that was made before.
    await user.click(cite);
    await user.click(cite);
    expect(screen.getByTestId('example-copy-status-ieee14')).toHaveTextContent('');
  });

  it('copies them as BibTeX', async () => {
    const success = vi.spyOn(toast, 'success');
    const user = await openDialog();
    stubClipboard({ writeText });
    await user.click(card('ieee14').getByRole('button', { name: /^Cite/ }));
    await user.click(card('ieee14').getByRole('button', { name: /^Copy as BibTeX/ }));
    expect(writeText).toHaveBeenCalledWith(
      '@misc{uw_ieee14,\n  title = {{IEEE} 14 Bus Test Case}\n}\n\n@article{cui2021andes,\n  title = {ANDES}\n}',
    );
    expect(success).toHaveBeenCalledWith(
      'Copied the BibTeX of IEEE 14-bus, with machines and controls',
      expect.anything(),
    );
  });

  it('says so, and where to copy it by hand, when the browser refuses the clipboard', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    const error = vi.spyOn(toast, 'error');
    const user = await openDialog();
    stubClipboard({ writeText });
    await user.click(card('ieee14').getByRole('button', { name: /^Cite/ }));
    await user.click(card('ieee14').getByRole('button', { name: /^Copy as text/ }));
    expect(error).toHaveBeenCalledWith(
      'The browser did not let the citation be copied',
      expect.objectContaining({ description: expect.stringContaining('copy it by hand') }),
    );
    // The text is on screen to select.
    expect(screen.getByText(/H. Cui, F. Li and K. Tomsovic/)).toBeVisible();
  });

  it('says so when there is no clipboard at all', async () => {
    const error = vi.spyOn(toast, 'error');
    const user = await openDialog();
    await user.click(card('ieee14').getByRole('button', { name: /^Cite/ }));
    stubClipboard(undefined);
    await user.click(card('ieee14').getByRole('button', { name: /^Copy as BibTeX/ }));
    expect(error).toHaveBeenCalledWith(
      'The browser did not let the BibTeX be copied',
      expect.anything(),
    );
  });
});

describe('the filter and the states of the list', () => {
  it('narrows the cards to what is typed and counts them', async () => {
    const user = await openDialog();
    await user.type(screen.getByRole('searchbox', { name: 'Filter the example cases' }), 'wscc');
    expect(screen.getByTestId('example-card-ieee14')).not.toBeVisible();
    expect(screen.getByTestId('example-card-wscc9')).toBeVisible();
    expect(screen.getByTestId('example-cases-count')).toHaveTextContent('1 of 3');
    // A group with nothing left in it is not an empty heading.
    expect(screen.getByTestId('example-group-dynamic')).not.toBeVisible();
    expect(screen.getByTestId('example-group-steady-state')).toBeVisible();
    // What is hidden is not in the reading order or the tab order either.
    expect(screen.queryByRole('button', { name: /^Cite: IEEE 14-bus/ })).toBeNull();
    expect(screen.getAllByRole('article')).toHaveLength(1);
  });

  it('keeps what was opened in a card while the filter hides it, for when it is cleared', async () => {
    const user = await openDialog();
    await user.click(card('ieee14').getByRole('button', { name: /^Cite/ }));
    await user.click(card('ieee14').getByText('Caveats, changes and checks'));
    expect(screen.getByTestId('example-cite-panel-ieee14')).toBeVisible();
    // A filter that leaves nothing to show, which is also what typing the text of a
    // reference into it does, and one that leaves another case.
    await user.type(screen.getByRole('searchbox'), 'zzz');
    expect(screen.getByTestId('example-card-ieee14')).not.toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Clear the filter' }));
    expect(screen.getByTestId('example-cite-panel-ieee14')).toBeVisible();
    expect(screen.getByTestId('example-details-ieee14')).toHaveAttribute('open');
    await user.type(screen.getByRole('searchbox'), 'wscc');
    expect(screen.getByTestId('example-card-ieee14')).not.toBeVisible();
    await user.clear(screen.getByRole('searchbox'));
    expect(screen.getByTestId('example-card-ieee14')).toBeVisible();
    expect(screen.getByTestId('example-cite-panel-ieee14')).toBeVisible();
    expect(screen.getByTestId('example-details-ieee14')).toHaveAttribute('open');
  });

  it('says nothing matches, and Clear the filter brings the list back', async () => {
    const user = await openDialog();
    await user.type(screen.getByRole('searchbox'), 'zzz');
    expect(screen.getByTestId('example-cases-none')).toHaveTextContent(
      'No example case matches “zzz”.',
    );
    expect(screen.getByTestId('example-card-ieee14')).not.toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Clear the filter' }));
    expect(screen.getByTestId('example-card-ieee14')).toBeVisible();
    expect(screen.queryByTestId('example-cases-none')).not.toBeInTheDocument();
    expect(screen.getByRole('searchbox')).toHaveValue('');
  });

  it('says it is loading, with the filter already there', async () => {
    let release: (r: Response) => void = () => undefined;
    vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch').mockImplementation(
      () => new Promise<Response>((resolve) => (release = resolve)),
    );
    renderDialog();
    await userEvent.setup().click(screen.getByTestId('example-cases-open'));
    expect(await screen.findByTestId('example-cases-loading')).toHaveTextContent(
      'Loading the example cases…',
    );
    // The dialog opens with the cursor in the filter, whether or not the list has come.
    expect(screen.getByRole('searchbox', { name: 'Filter the example cases' })).toHaveFocus();
    release(jsonResponse({ examples: [] }));
    expect(await screen.findByTestId('example-cases-none')).toHaveTextContent(
      'This server has no example cases.',
    );
  });

  it('says why the list could not be read, and Try again reads it', async () => {
    server.listFails = true;
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByTestId('example-cases-open'));
    const alert = await screen.findByTestId('example-cases-error');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent('Could not load the example cases: the catalog is damaged');
    server.listFails = false;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('example-card-ieee14')).toBeInTheDocument();
  });
});

describe('what the dialog says of the workspace', () => {
  const note = () => screen.getByTestId('example-cases-workspace-note');
  const inWorkspace = (...ids: string[]) => {
    server.examples = server.examples.map((e) =>
      ids.includes(e.id) ? { ...e, in_workspace: true } : e,
    );
  };

  it('says nothing is added yet, and what Add and Open do, when no case is in the workspace', async () => {
    await openDialog();
    expect(note()).toHaveTextContent('None of these cases is in your workspace yet.');
    expect(note()).toHaveTextContent('Add to workspace copies the file of a case there');
  });

  it('says how many are added, and why, when some are', async () => {
    inWorkspace('ieee14');
    await openDialog();
    // The entry that is only links has no file, so it is not counted.
    expect(note()).toHaveTextContent(
      '1 of 2 cases are already in your workspace and say Added (a new workspace starts with the default set).',
    );
  });

  it('says there is nothing to add, and how Add comes back, when all are', async () => {
    inWorkspace('ieee14', 'wscc9');
    await openDialog();
    expect(note()).toHaveTextContent(
      'All 2 cases are already in your workspace and say Added (a new workspace starts with the default set), so there is nothing to add: choose Open to load one.',
    );
    expect(note()).toHaveTextContent('offers Add to workspace again');
  });

  it('follows an add: the count is read again once the case is in', async () => {
    inWorkspace('ieee14');
    const user = await openDialog();
    expect(note()).toHaveTextContent('1 of 2 cases are already in your workspace');
    await user.click(card('wscc9').getByRole('button', { name: /^Add to workspace/ }));
    await waitFor(() =>
      expect(note()).toHaveTextContent('All 2 cases are already in your workspace'),
    );
  });

  it('does not change with the filter, and is not shown before the list has come', async () => {
    inWorkspace('ieee14');
    const user = await openDialog();
    await user.type(screen.getByRole('searchbox'), 'wscc');
    expect(note()).toHaveTextContent('1 of 2 cases are already in your workspace');
  });

  it('is not there when no case has a file', async () => {
    server.examples = server.examples.filter((e) => e.id === 'texas-dynamic');
    await openDialog('texas-dynamic');
    expect(screen.queryByTestId('example-cases-workspace-note')).not.toBeInTheDocument();
  });

  it('is not there while the list is loading', async () => {
    vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch').mockImplementation(
      () => new Promise<Response>(() => undefined),
    );
    renderDialog();
    await userEvent.setup().click(screen.getByTestId('example-cases-open'));
    await screen.findByTestId('example-cases-loading');
    expect(screen.queryByTestId('example-cases-workspace-note')).not.toBeInTheDocument();
  });
});

describe('the dialog as a whole', () => {
  it('opens with the keyboard focus in the filter', async () => {
    await openDialog();
    expect(screen.getByRole('searchbox', { name: 'Filter the example cases' })).toHaveFocus();
  });

  it('closes on Escape and on Close, and gives the focus back to what opened it', async () => {
    const user = await openDialog();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('example-cases-dialog')).toBeNull());
    expect(useExampleCasesStore.getState().dialogOpen).toBe(false);
    expect(screen.getByTestId('example-cases-open')).toHaveFocus();

    await user.click(screen.getByTestId('example-cases-open'));
    await screen.findByTestId('example-card-ieee14');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByTestId('example-cases-dialog')).toBeNull());
    expect(screen.getByTestId('example-cases-open')).toHaveFocus();
  });

  it('names every button by its action and its case, so a list of them reads clearly', async () => {
    await openDialog();
    expect(
      screen.getByRole('button', { name: 'Add to workspace: WSCC 9-bus, network only' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Cite: WSCC 9-bus, network only' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', {
        name: 'Open source page for Electric Grid Test Case Repository (opens in a new tab)',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole('article').map((a) => a.getAttribute('aria-labelledby')),
    ).toHaveLength(3);
    expect(
      screen.getByRole('article', { name: 'IEEE 14-bus, with machines and controls' }),
    ).toBeInTheDocument();
  });
});
