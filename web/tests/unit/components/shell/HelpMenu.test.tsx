/**
 * Tests for `<HelpMenu />`, the top bar's "?" button: the keyboard shortcuts,
 * the documentation links, and the versions the server runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';

import { HelpMenu } from '@/components/shell/HelpMenu';
import { HELP_LINKS, REPO_URL } from '@/lib/helpLinks';
import { useShortcutCheatsheetStore } from '@/store/shortcutCheatsheet';

let fetchSpy: ReturnType<typeof vi.spyOn>;

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

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch') as ReturnType<
    typeof vi.spyOn
  >;
  fetchSpy.mockImplementation(() =>
    Promise.resolve(jsonResponse({ tensa: '0.5.0', andes: '2.0.0' })),
  );
  useShortcutCheatsheetStore.setState({ open: false, section: null });
});

afterEach(() => {
  cleanup();
  fetchSpy.mockRestore();
  useShortcutCheatsheetStore.setState({ open: false, section: null });
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
