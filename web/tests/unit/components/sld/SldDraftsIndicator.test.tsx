/**
 * The list of drafts over the diagram: a button that counts the drafts and
 * says how many are incomplete, and opens the list, where a row picks its
 * draft and a button beside it deletes it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SldDraftsIndicator } from '@/components/sld/SldDraftsIndicator';
import type { DraftRow } from '@/components/sld/drafts';

const ROWS: DraftRow[] = [
  { id: 'draft-1', kind: 'PV', name: 'PV generator 6', ready: true, summary: 'Ready to add' },
  { id: 'draft-2', kind: 'Bus', name: 'Bus 15', ready: false, summary: 'Missing name and Vn' },
  { id: 'draft-3', kind: 'Line', name: 'Line Line_21', ready: false, summary: 'Missing r and x' },
];

function renderIndicator(rows: readonly DraftRow[] = ROWS, selectedId: string | null = null) {
  const handlers = { onSelect: vi.fn(), onDelete: vi.fn(), onDeleteAll: vi.fn() };
  render(<SldDraftsIndicator rows={rows} selectedId={selectedId} {...handlers} />);
  return handlers;
}

afterEach(cleanup);

describe('<SldDraftsIndicator />', () => {
  it('draws nothing while the diagram has no draft', () => {
    renderIndicator([]);
    expect(screen.queryByTestId('sld-drafts-indicator')).toBeNull();
  });

  it('counts the drafts and says how many are incomplete, in words a screen reader has too', () => {
    renderIndicator();
    const button = screen.getByTestId('sld-drafts-indicator');
    expect(button).toHaveTextContent('Drafts');
    expect(button).toHaveTextContent('3');
    expect(button).toHaveTextContent('2 incomplete');
    expect(button).toHaveAttribute('data-draft-count', '3');
    expect(button).toHaveAttribute('data-incomplete-count', '2');
    expect(button).toHaveAccessibleName(
      '3 drafts, 2 incomplete. Elements placed on the diagram that are not in the system yet. Open the list.',
    );
    // Not part of a picture of the view.
    expect(button).toHaveAttribute('data-export-ignore');
  });

  it('says so when every draft is ready, and counts one draft as one', () => {
    renderIndicator([ROWS[0]!]);
    const button = screen.getByTestId('sld-drafts-indicator');
    expect(button).toHaveTextContent('ready');
    expect(button).toHaveAccessibleName(/^1 draft, all ready to add\./);
  });

  it('lists each draft with what it lacks, in the order they were placed', async () => {
    const user = userEvent.setup();
    renderIndicator(ROWS, 'draft-2');
    expect(screen.queryByTestId('sld-drafts-list')).toBeNull();
    await user.click(screen.getByTestId('sld-drafts-indicator'));
    const list = screen.getByTestId('sld-drafts-list');
    expect(list).toHaveTextContent('Drafts: not in the system yet');
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('PV generator 6Ready to add'),
      expect.stringContaining('Bus 15Incomplete. Missing name and Vn'),
      expect.stringContaining('Line Line_21Incomplete. Missing r and x'),
    ]);
    expect(screen.getByTestId('sld-drafts-row-draft-1')).toHaveAttribute('data-ready', 'true');
    // The one that is picked is marked.
    expect(screen.getByTestId('sld-drafts-row-draft-2')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('sld-drafts-row-draft-1')).not.toHaveAttribute('aria-current');
  });

  it('picks the draft of a row, and closes the list', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderIndicator();
    await user.click(screen.getByTestId('sld-drafts-indicator'));
    await user.click(screen.getByTestId('sld-drafts-row-draft-3'));
    expect(onSelect).toHaveBeenCalledWith('draft-3');
    expect(screen.queryByTestId('sld-drafts-list')).toBeNull();
  });

  it('deletes the draft of a row by the button beside it, which names it, and stays open', async () => {
    const user = userEvent.setup();
    const { onDelete, onSelect } = renderIndicator();
    await user.click(screen.getByTestId('sld-drafts-indicator'));
    await user.click(screen.getByRole('button', { name: 'Delete draft Bus 15' }));
    expect(onDelete).toHaveBeenCalledWith('draft-2');
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByTestId('sld-drafts-list')).toBeInTheDocument();
  });

  it('deletes them all by the button under the list, which says how many', async () => {
    const user = userEvent.setup();
    const { onDeleteAll } = renderIndicator();
    await user.click(screen.getByTestId('sld-drafts-indicator'));
    await user.click(screen.getByRole('button', { name: 'Delete all 3 drafts' }));
    expect(onDeleteAll).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('sld-drafts-list')).toBeNull();
  });

  it('has no button for all of them while there is only one', async () => {
    const user = userEvent.setup();
    renderIndicator([ROWS[1]!]);
    await user.click(screen.getByTestId('sld-drafts-indicator'));
    expect(screen.queryByTestId('sld-drafts-delete-all')).toBeNull();
  });
});

describe('<SldDraftsIndicator /> with a parent that opens the list too', () => {
  // The notice of drafts kept from an earlier visit has a Show button.
  it('is open when the parent says so, and asks the parent to open and close it', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const handlers = { onSelect: vi.fn(), onDelete: vi.fn(), onDeleteAll: vi.fn() };
    const { rerender } = render(
      <SldDraftsIndicator
        rows={ROWS}
        selectedId={null}
        {...handlers}
        open={false}
        onOpenChange={onOpenChange}
      />,
    );
    expect(screen.queryByTestId('sld-drafts-list')).toBeNull();
    // A press on the button asks; nothing opens until the parent agrees.
    await user.click(screen.getByTestId('sld-drafts-indicator'));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    expect(screen.queryByTestId('sld-drafts-list')).toBeNull();
    rerender(
      <SldDraftsIndicator
        rows={ROWS}
        selectedId={null}
        {...handlers}
        open
        onOpenChange={onOpenChange}
      />,
    );
    expect(screen.getByTestId('sld-drafts-list')).toBeInTheDocument();
    // A pick in the list asks for it to be closed.
    await user.click(screen.getByTestId('sld-drafts-row-draft-2'));
    expect(handlers.onSelect).toHaveBeenCalledWith('draft-2');
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });
});
