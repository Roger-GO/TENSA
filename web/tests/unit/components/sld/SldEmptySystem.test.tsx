/**
 * SldEmptySystem: the page a system with nothing in it shows where its
 * diagram will be. Its button opens the form for the first bus, and a row of
 * the Components palette dropped on it is placed as a draft, as one dropped
 * on a diagram is.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SldEmptySystem } from '@/components/sld/SldEmptySystem';
import { useCaseStore } from '@/store/case';
import { BLANK_CASE_KEY, useDraftsStore } from '@/store/drafts';
import { useSldStore } from '@/store/sld';

const MIME = 'application/andes-component-type';

function drop(target: HTMLElement, kind: string): void {
  const dataTransfer = {
    getData: (mime: string) => (mime === MIME ? kind : ''),
    types: [MIME],
    dropEffect: 'copy',
  };
  fireEvent(target, createEvent.drop(target, { dataTransfer }));
}

beforeEach(() => {
  useCaseStore.setState({ selection: { primaryPath: null, addfiles: [], blank: true } });
  useCaseStore.getState().closeAddPanel();
  useDraftsStore.setState({ byCase: {}, placements: {} });
  useSldStore.getState().clearSelectedNodeId();
});

afterEach(() => {
  cleanup();
  useCaseStore.getState().clearCase();
  useDraftsStore.setState({ byCase: {}, placements: {} });
});

describe('<SldEmptySystem />', () => {
  it('opens the form for the first bus from its button', async () => {
    const user = userEvent.setup();
    render(<SldEmptySystem />);
    await user.click(screen.getByRole('button', { name: 'Add a Bus' }));
    expect(useCaseStore.getState()).toMatchObject({ addPanelOpen: true, addPanelKind: 'Bus' });
  });

  it('places a row of the palette that is dropped on it as a draft, picked, with no form opened', () => {
    render(<SldEmptySystem />);
    drop(screen.getByTestId('sld-empty-system'), 'PQ');
    expect(useDraftsStore.getState().byCase[BLANK_CASE_KEY]).toMatchObject([
      { id: 'draft-1', kind: 'PQ', values: {} },
    ]);
    expect(useSldStore.getState().selectedNodeId).toBe('draft-1');
    expect(useCaseStore.getState().addPanelOpen).toBe(false);
  });
});
