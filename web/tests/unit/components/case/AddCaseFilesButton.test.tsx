/**
 * The Add files button: the browser's file chooser, restricted to the case
 * formats, and whatever it returns goes to the workspace as a drop would.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AddCaseFilesButton } from '@/components/case/AddCaseFilesButton';

const addFiles = vi.fn();
let isUploading = false;
vi.mock('@/lib/useAddWorkspaceFiles', () => ({
  useAddWorkspaceFiles: () => ({ addFiles, isUploading }),
}));

beforeEach(() => {
  addFiles.mockReset();
  addFiles.mockResolvedValue(undefined);
  isUploading = false;
});

afterEach(() => {
  cleanup();
});

describe('<AddCaseFilesButton />', () => {
  it('offers the case formats, several files at once', () => {
    render(<AddCaseFilesButton />);
    const input = screen.getByTestId('add-case-files-input');
    expect(input).toHaveAttribute('type', 'file');
    expect(input).toHaveAttribute('multiple');
    expect(input.getAttribute('accept')?.split(',').sort()).toEqual([
      '.dyr',
      '.json',
      '.m',
      '.raw',
      '.xlsx',
    ]);
  });

  it('opens the file chooser when it is clicked', async () => {
    const user = userEvent.setup();
    render(<AddCaseFilesButton />);
    const chooser = vi.spyOn(screen.getByTestId('add-case-files-input'), 'click');
    await user.click(screen.getByTestId('add-case-files'));
    expect(chooser).toHaveBeenCalledTimes(1);
    // Nothing is sent until files are picked.
    expect(addFiles).not.toHaveBeenCalled();
  });

  it('adds the files that were picked', async () => {
    const user = userEvent.setup();
    render(<AddCaseFilesButton />);
    const raw = new File(['raw'], 'ieee14.raw');
    const dyr = new File(['dyr'], 'ieee14.dyr');
    await user.upload(screen.getByTestId('add-case-files-input'), [raw, dyr]);
    await waitFor(() => expect(addFiles).toHaveBeenCalledTimes(1));
    expect(addFiles).toHaveBeenCalledWith([raw, dyr]);
  });

  it('lets the same file be picked again', async () => {
    const user = userEvent.setup();
    render(<AddCaseFilesButton />);
    const input = screen.getByTestId('add-case-files-input') as HTMLInputElement;
    await user.upload(input, new File(['raw'], 'ieee14.raw'));
    await waitFor(() => expect(addFiles).toHaveBeenCalledTimes(1));
    // The chooser keeps no selection, so picking that file again fires `change`.
    expect(input.value).toBe('');
  });

  it('shows that files are being added, and cannot be pressed meanwhile', () => {
    isUploading = true;
    render(<AddCaseFilesButton />);
    const button = screen.getByTestId('add-case-files');
    expect(button).toHaveTextContent('Adding…');
    expect(button).toBeDisabled();
  });

  it('reads Add files when idle, and says dropping works too', () => {
    render(<AddCaseFilesButton />);
    const button = screen.getByTestId('add-case-files');
    expect(button).toHaveTextContent('Add files…');
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute('title', expect.stringContaining('drop them anywhere'));
  });
});
