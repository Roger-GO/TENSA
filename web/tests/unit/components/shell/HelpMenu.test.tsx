/**
 * Tests for `<HelpMenu />`, the top bar's "?" button: the keyboard shortcuts,
 * the documentation links, and the versions the server runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';

import { HelpMenu } from '@/components/shell/HelpMenu';
import { HELP_LINKS, REPO_URL } from '@/lib/helpLinks';
import type { EngineList } from '@/api/types';
import { useSessionStore } from '@/store/session';
import { useShortcutCheatsheetStore } from '@/store/shortcutCheatsheet';

let fetchSpy: MockInstance<typeof fetch>;

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function requestedPaths(): string[] {
  return fetchSpy.mock.calls.map((call: unknown[]) => {
    const input = call[0] as string | Request;
    return typeof input === 'string' ? input : input.url;
  });
}

const ANDES_ENTRY = {
  name: 'andes',
  available: true,
  unavailable_reason: null,
  versions: { andes: '2.0.0' },
  formats: { read: [], write: [] },
  routines: ['pflow', 'tds', 'eig', 'cpf', 'se'],
  ops: [],
  editing: true,
};

const SIENNA_VERSIONED = {
  name: 'sienna',
  available: true,
  unavailable_reason: null,
  versions: {
    julia: '1.11.3',
    PowerSystems: '5.12.5',
    PowerFlows: '0.16.4',
    PowerNetworkMatrices: '0.15.2',
    PowerSimulationsDynamics: '0.18.1',
  },
  formats: { read: [], write: [] },
  routines: ['pflow', 'tds'],
  ops: [],
  editing: false,
};

function engineList(...entries: unknown[]): EngineList {
  return { engines: entries } as EngineList;
}

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch');
  fetchSpy.mockImplementation(() =>
    Promise.resolve(jsonResponse({ tensa: '0.5.0', andes: '2.0.0' })),
  );
  useShortcutCheatsheetStore.setState({ open: false, section: null });
  useSessionStore.setState({ engines: null });
});

afterEach(() => {
  cleanup();
  fetchSpy.mockRestore();
  useShortcutCheatsheetStore.setState({ open: false, section: null });
  useSessionStore.setState({ engines: null });
});

async function openMenu() {
  const user = userEvent.setup();
  renderWithClient(<HelpMenu />);
  await user.click(screen.getByTestId('topbar-menu-help-trigger'));
  await screen.findByTestId('topbar-menu-help-content');
  return user;
}

describe('<HelpMenu />', () => {
  it('is an icon-only Help button that opens a menu', async () => {
    renderWithClient(<HelpMenu />);
    const trigger = screen.getByRole('button', { name: 'Help' });
    expect(trigger).toHaveAttribute('data-testid', 'topbar-menu-help-trigger');
    expect(trigger).not.toHaveTextContent('Help');
    // Nothing is fetched until the menu is opened.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('links to the API reference, the API map, the ANDES model docs and the repository', async () => {
    await openMenu();
    const content = screen.getByTestId('topbar-menu-help-content');
    const links = within(content)
      .getAllByRole('menuitem')
      .filter((el) => el.tagName === 'A');
    expect(
      links.map((a) => [a.getAttribute('data-testid'), a.getAttribute('href'), a.textContent]),
    ).toEqual([
      ['topbar-menu-help-link-api-docs', '/docs', 'API reference/docs'],
      [
        'topbar-menu-help-link-llms',
        `${REPO_URL}/blob/main/llms.txt`,
        'API map for agentsllms.txt',
      ],
      [
        'topbar-menu-help-link-andes-models',
        'https://docs.andes.app/en/stable/reference/models/index.html',
        'ANDES model docsdocs.andes.app',
      ],
      ['topbar-menu-help-link-repo', REPO_URL, 'TENSA on GitHubRoger-GO/TENSA'],
    ]);
    for (const a of links) {
      expect(a).toHaveAttribute('target', '_blank');
      expect(a).toHaveAttribute('rel', 'noopener noreferrer');
    }
  });

  it('keeps every external link on https and the API reference on this server', () => {
    const [apiDocs, ...external] = HELP_LINKS;
    expect(apiDocs?.href).toBe('/docs');
    for (const link of external) expect(link.href).toMatch(/^https:\/\//);
    expect(new Set(HELP_LINKS.map((l) => l.id)).size).toBe(HELP_LINKS.length);
  });

  it('says which TENSA and ANDES versions the server runs, as the API reports them', async () => {
    await openMenu();
    await waitFor(() => expect(screen.getByTestId('help-about-tensa')).toHaveTextContent('0.5.0'));
    expect(screen.getByTestId('help-about-andes')).toHaveTextContent('2.0.0');
    expect(requestedPaths()).toEqual(['/api/version']);
    expect(screen.getByRole('group', { name: 'About TENSA' })).toBeInTheDocument();
  });

  it('shows a placeholder while the versions load', async () => {
    fetchSpy.mockImplementation(() => new Promise<Response>(() => {}));
    await openMenu();
    expect(screen.getByTestId('help-about-tensa')).toHaveTextContent('…');
    expect(screen.getByTestId('help-about-andes')).toHaveTextContent('…');
  });

  it('says "unavailable" when the server cannot report its versions', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(jsonResponse({ title: 'Not Found', status: 404 }, 404)),
    );
    await openMenu();
    await waitFor(() =>
      expect(screen.getByTestId('help-about-tensa')).toHaveTextContent('unavailable'),
    );
    expect(screen.getByTestId('help-about-andes')).toHaveTextContent('unavailable');
  });

  it('asks the server once, however often the menu is opened', async () => {
    const user = await openMenu();
    await waitFor(() => expect(screen.getByTestId('help-about-tensa')).toHaveTextContent('0.5.0'));
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByTestId('topbar-menu-help-content')).not.toBeInTheDocument(),
    );
    await user.click(screen.getByTestId('topbar-menu-help-trigger'));
    await screen.findByTestId('topbar-menu-help-content');
    expect(screen.getByTestId('help-about-tensa')).toHaveTextContent('0.5.0');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('shows one row per engine with a non-empty versions map, ANDES excepted', async () => {
    // The ANDES row above already shows the ANDES version, so the ANDES
    // engine gets no row of its own. The expected line is written out by
    // hand: julia first, then the packages alphabetically.
    useSessionStore.setState({ engines: engineList(ANDES_ENTRY, SIENNA_VERSIONED) });
    await openMenu();
    const about = screen.getByTestId('help-about');
    expect(within(about).getByText('Sienna packages')).toBeInTheDocument();
    expect(screen.getByTestId('help-about-engine-sienna')).toHaveTextContent(
      'julia 1.11.3, PowerFlows 0.16.4, PowerNetworkMatrices 0.15.2, ' +
        'PowerSimulationsDynamics 0.18.1, PowerSystems 5.12.5',
    );
    expect(screen.queryByTestId('help-about-engine-andes')).toBeNull();
    expect(about).not.toHaveTextContent('ANDES packages');
  });

  it('shows no engine row for an engine with an empty versions map', async () => {
    useSessionStore.setState({
      engines: engineList(ANDES_ENTRY, { ...SIENNA_VERSIONED, versions: {} }),
    });
    await openMenu();
    expect(screen.queryByTestId('help-about-engine-sienna')).toBeNull();
    expect(screen.queryByTestId('help-about-engine-andes')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('help-about-tensa')).toHaveTextContent('0.5.0'));
    expect(screen.getByTestId('help-about-andes')).toHaveTextContent('2.0.0');
  });

  it('shows no engine rows while the list is not loaded, and the TENSA and ANDES rows as today', async () => {
    useSessionStore.setState({ engines: null });
    await openMenu();
    expect(screen.queryByTestId('help-about-engine-sienna')).toBeNull();
    expect(screen.queryByTestId('help-about-engine-andes')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('help-about-tensa')).toHaveTextContent('0.5.0'));
    expect(screen.getByTestId('help-about-andes')).toHaveTextContent('2.0.0');
  });

  it('has an entry of its own for moving a line by hand and for connecting, which open that part of the list', async () => {
    // Nobody looks for a drag under "Keyboard shortcuts".
    const user = await openMenu();
    await user.click(screen.getByRole('menuitem', { name: 'Moving a line by hand' }));
    expect(useShortcutCheatsheetStore.getState()).toMatchObject({ open: true, section: 'diagram' });

    useShortcutCheatsheetStore.setState({ open: false, section: null });
    await user.click(screen.getByTestId('topbar-menu-help-trigger'));
    await user.click(await screen.findByRole('menuitem', { name: 'Connecting on the diagram' }));
    expect(useShortcutCheatsheetStore.getState()).toMatchObject({ open: true, section: 'connect' });
  });

  it('opens the keyboard shortcuts, which the ? key opens too', async () => {
    const user = await openMenu();
    const item = screen.getByTestId('topbar-menu-help-shortcuts');
    expect(item).toHaveTextContent('Keyboard shortcuts');
    expect(item).toHaveTextContent('?');
    await user.click(item);
    expect(useShortcutCheatsheetStore.getState().open).toBe(true);
    await waitFor(() =>
      expect(screen.queryByTestId('topbar-menu-help-content')).not.toBeInTheDocument(),
    );
  });
});
