/**
 * The window-wide drop target: files dropped anywhere are added to the workspace,
 * a hint shows while they are over the window, and nothing else is touched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';

import { WorkspaceDropTarget } from '@/components/shell/WorkspaceDropTarget';

const addFiles = vi.fn();
vi.mock('@/lib/useAddWorkspaceFiles', () => ({
  useAddWorkspaceFiles: () => ({ addFiles, isUploading: false }),
}));

/** What the browser puts on a drag: `types` during the drag, `files` only on the drop. */
function dataTransfer(types: string[], files: File[] = []) {
  return { types, files, dropEffect: 'none' };
}

/** Dispatch a drag event on `target` and return it, so `defaultPrevented` can be read. */
function drag(
  type: 'dragEnter' | 'dragOver' | 'dragLeave' | 'drop',
  target: Element | Window,
  transfer: ReturnType<typeof dataTransfer>,
) {
  const event = createEvent[type](target, { dataTransfer: transfer });
  act(() => {
    fireEvent(target, event);
  });
  return event;
}

const overlay = () => screen.queryByTestId('workspace-drop-overlay');

beforeEach(() => {
  addFiles.mockReset();
  addFiles.mockResolvedValue(undefined);
  render(
    <div>
      <button type="button" data-testid="somewhere">
        somewhere
      </button>
      <input type="file" data-testid="chooser" />
      <WorkspaceDropTarget />
    </div>,
  );
});

afterEach(() => {
  cleanup();
});

describe('<WorkspaceDropTarget />', () => {
  it('shows nothing until files are dragged over the window', () => {
    expect(overlay()).toBeNull();
  });

  it('shows the hint, with the formats and the size limit, while files are over the window', () => {
    drag('dragEnter', screen.getByTestId('somewhere'), dataTransfer(['Files']));
    expect(overlay()).toBeInTheDocument();
    expect(overlay()).toHaveTextContent('Drop to add to the workspace');
    expect(overlay()).toHaveTextContent('.raw, .dyr, .m, .xlsx, .json');
    expect(overlay()).toHaveTextContent('32 MiB');
  });

  it('hides the hint when the drag leaves the window, however many elements it crossed', () => {
    const somewhere = screen.getByTestId('somewhere');
    const files = dataTransfer(['Files']);
    // Into the page, then into a child, out of the first: still over the window.
    drag('dragEnter', document.body, files);
    drag('dragEnter', somewhere, files);
    drag('dragLeave', document.body, files);
    expect(overlay()).toBeInTheDocument();
    drag('dragLeave', somewhere, files);
    expect(overlay()).toBeNull();
  });

  it('claims the drag so the browser does not open the file', () => {
    const files = dataTransfer(['Files']);
    const over = drag('dragOver', screen.getByTestId('somewhere'), files);
    expect(over.defaultPrevented).toBe(true);
    expect(files.dropEffect).toBe('copy');
  });

  it('adds the files that are dropped, and hides the hint', () => {
    const raw = new File(['raw'], 'ieee14.raw');
    const dyr = new File(['dyr'], 'ieee14.dyr');
    const somewhere = screen.getByTestId('somewhere');
    drag('dragEnter', somewhere, dataTransfer(['Files']));
    const dropped = drag('drop', somewhere, dataTransfer(['Files'], [raw, dyr]));
    expect(dropped.defaultPrevented).toBe(true);
    expect(addFiles).toHaveBeenCalledTimes(1);
    expect(addFiles).toHaveBeenCalledWith([raw, dyr]);
    expect(overlay()).toBeNull();
  });

  it('takes a drop on the window itself', () => {
    const raw = new File(['raw'], 'ieee14.raw');
    drag('drop', window, dataTransfer(['Files'], [raw]));
    expect(addFiles).toHaveBeenCalledWith([raw]);
  });

  it('adds nothing for a drop that carries no files', () => {
    drag('drop', screen.getByTestId('somewhere'), dataTransfer(['Files'], []));
    expect(addFiles).not.toHaveBeenCalled();
  });

  it('leaves a drag that is not files alone, such as a Component library tile', () => {
    const somewhere = screen.getByTestId('somewhere');
    const tile = dataTransfer(['application/x-tensa-component']);
    expect(drag('dragEnter', somewhere, tile).defaultPrevented).toBe(false);
    expect(drag('dragOver', somewhere, tile).defaultPrevented).toBe(false);
    expect(overlay()).toBeNull();
    expect(drag('drop', somewhere, tile).defaultPrevented).toBe(false);
    expect(addFiles).not.toHaveBeenCalled();
  });

  it('leaves a drag over a file input to the input', () => {
    const chooser = screen.getByTestId('chooser');
    const files = dataTransfer(['Files'], [new File(['raw'], 'ieee14.raw')]);
    expect(drag('dragEnter', chooser, files).defaultPrevented).toBe(false);
    expect(drag('dragOver', chooser, files).defaultPrevented).toBe(false);
    expect(overlay()).toBeNull();
    expect(drag('drop', chooser, files).defaultPrevented).toBe(false);
    expect(addFiles).not.toHaveBeenCalled();
  });

  describe('while a dialog is open', () => {
    const raw = () => new File(['raw'], 'ieee14.raw');

    it('refuses the drag, with no hint and no files added, but still cancels the drop', () => {
      render(<div role="dialog" data-state="open" data-testid="dialog" />);
      const dialog = screen.getByTestId('dialog');
      const files = dataTransfer(['Files'], [raw()]);
      expect(drag('dragEnter', dialog, files).defaultPrevented).toBe(true);
      expect(overlay()).toBeNull();
      expect(drag('dragOver', dialog, files).defaultPrevented).toBe(true);
      expect(files.dropEffect).toBe('none');
      expect(drag('drop', dialog, files).defaultPrevented).toBe(true);
      expect(addFiles).not.toHaveBeenCalled();
    });

    it('refuses a drop beside the dialog as well, wherever on the window it lands', () => {
      render(<div role="dialog" data-state="open" />);
      drag('drop', screen.getByTestId('somewhere'), dataTransfer(['Files'], [raw()]));
      expect(addFiles).not.toHaveBeenCalled();
    });

    it('leaves a file input in the dialog to take its own drop', () => {
      render(
        <div role="dialog" data-state="open">
          <input type="file" data-testid="profile-input" />
        </div>,
      );
      const input = screen.getByTestId('profile-input');
      const files = dataTransfer(['Files'], [new File(['a,b'], 'profile.csv')]);
      expect(drag('drop', input, files).defaultPrevented).toBe(false);
      expect(addFiles).not.toHaveBeenCalled();
    });

    it('takes the drop again once the dialog has closed', () => {
      const { rerender } = render(<div role="dialog" data-state="open" />);
      rerender(<div role="dialog" data-state="closed" />);
      drag('drop', screen.getByTestId('somewhere'), dataTransfer(['Files'], [raw()]));
      expect(addFiles).toHaveBeenCalledTimes(1);
    });

    it('takes the drop with a popover open, which is not modal', () => {
      render(<div role="dialog" data-state="open" data-side="bottom" />);
      const files = dataTransfer(['Files'], [raw()]);
      drag('dragOver', screen.getByTestId('somewhere'), files);
      expect(files.dropEffect).toBe('copy');
      drag('drop', screen.getByTestId('somewhere'), files);
      expect(addFiles).toHaveBeenCalledTimes(1);
    });
  });

  it('stops listening when it unmounts', () => {
    cleanup();
    const raw = new File(['raw'], 'ieee14.raw');
    const dropped = drag('drop', document.body, dataTransfer(['Files'], [raw]));
    expect(dropped.defaultPrevented).toBe(false);
    expect(addFiles).not.toHaveBeenCalled();
  });
});
