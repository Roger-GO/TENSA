/**
 * Adding files to the workspace: what is sent, what the user is told, and which
 * case is opened. The server calls are stood in for; the opening goes through the
 * real `useOpenCase`, down to the load request it sends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { ProblemDetailsError } from '@/api/client';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import { MAX_CASE_UPLOAD_BYTES } from '@/lib/caseUpload';
import { useAddWorkspaceFiles } from '@/lib/useAddWorkspaceFiles';
import { toast } from '@/lib/toast';
import { useCaseStore } from '@/store/case';
import { useSessionStore } from '@/store/session';

const upload = vi.fn();
const loadCase = vi.fn();
const reload = vi.fn();
vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useUploadWorkspaceFile: () => ({ mutateAsync: upload }),
    useLoadCase: () => ({ mutateAsync: loadCase, isPending: false }),
    useReloadCase: () => ({ mutate: reload }),
  };
});

const file = (name: string, content = 'case data') => new File([content], name);

const stored = (name: string) => ({ name, size_bytes: 9, format: 'raw', replaced: false });

function problem(status: number, detail: string): ProblemDetailsError {
  return new ProblemDetailsError({
    type: 'about:blank',
    title: 'Problem',
    status,
    detail,
    instance: null,
  });
}

type ToastSpy = MockInstance<typeof toast.success>;

/** The action of the toast that `spy` was last called with. */
function actionOf(spy: ToastSpy) {
  const opts = spy.mock.calls.at(-1)?.[1] as { action?: { label: string; onClick: () => void } };
  return opts.action;
}

/** The action labelled `label` on the most recent toast of `spy` that has one. */
function actionLabelled(spy: ToastSpy, label: string) {
  for (const call of [...spy.mock.calls].reverse()) {
    const action = (call[1] as { action?: { label: string; onClick: () => void } } | undefined)
      ?.action;
    if (action?.label === label) return action;
  }
  return undefined;
}

let success: ToastSpy;
let warning: ToastSpy;
let error: ToastSpy;

beforeEach(() => {
  upload.mockReset();
  upload.mockImplementation(({ file: f }: { file: File }) => Promise.resolve(stored(f.name)));
  loadCase.mockReset();
  loadCase.mockResolvedValue({});
  reload.mockReset();
  useSessionStore.setState({ sessionId: parseSessionId('s1') });
  useCaseStore.setState({ selection: null });
  success = vi.spyOn(toast, 'success').mockReturnValue('id');
  warning = vi.spyOn(toast, 'warning').mockReturnValue('id');
  error = vi.spyOn(toast, 'error').mockReturnValue('id');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useAddWorkspaceFiles', () => {
  it('sends each file, in the order given, one after the other, and says what was added', async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    upload.mockImplementation(({ file: f }: { file: File }) => {
      order.push(`start ${f.name}`);
      return new Promise((resolve) => {
        release = () => {
          order.push(`end ${f.name}`);
          resolve(stored(f.name));
        };
      });
    });
    const { result } = renderHook(() => useAddWorkspaceFiles());
    expect(result.current.isUploading).toBe(false);

    let done: Promise<void> = Promise.resolve();
    act(() => {
      done = result.current.addFiles([file('a.dyr'), file('b.dyr')]);
    });
    expect(result.current.isUploading).toBe(true);
    await act(async () => {
      release();
      await Promise.resolve();
    });
    expect(order).toEqual(['start a.dyr', 'end a.dyr', 'start b.dyr']);
    await act(async () => {
      release();
      await done;
    });
    expect(order.at(-1)).toBe('end b.dyr');
    expect(result.current.isUploading).toBe(false);
    expect(success).toHaveBeenCalledWith('Added 2 files to the workspace.', {
      description: 'a.dyr and b.dyr',
    });
  });

  it('does not overwrite: it sends no overwrite flag of its own', async () => {
    const { result } = renderHook(() => useAddWorkspaceFiles());
    const f = file('a.dyr');
    await act(() => result.current.addFiles([f]));
    expect(upload).toHaveBeenCalledWith({ file: f });
  });

  it('says what a single file did and leaves a lone .dyr to be paired with a case', async () => {
    const { result } = renderHook(() => useAddWorkspaceFiles());
    await act(() => result.current.addFiles([file('ieee14.dyr')]));
    expect(success).toHaveBeenCalledWith('Added ieee14.dyr to the workspace.', {
      description: undefined,
    });
    expect(loadCase).not.toHaveBeenCalled();
  });

  it('opens a case that was added while nothing is open', async () => {
    const { result } = renderHook(() => useAddWorkspaceFiles());
    await act(() => result.current.addFiles([file('ieee14.xlsx')]));
    expect(loadCase).toHaveBeenCalledTimes(1);
    expect(loadCase.mock.calls[0]?.[0]).toEqual({
      sessionId: 's1',
      request: { primary_path: 'ieee14.xlsx', addfiles: null },
    });
  });

  it('opens a .raw with the .dyr files dropped with it', async () => {
    const { result } = renderHook(() => useAddWorkspaceFiles());
    await act(() => result.current.addFiles([file('ieee14.dyr'), file('ieee14.raw')]));
    expect(loadCase.mock.calls[0]?.[0]).toEqual({
      sessionId: 's1',
      request: { primary_path: 'ieee14.raw', addfiles: ['ieee14.dyr'] },
    });
  });

  it('opens nothing when two cases came together, since neither is the one', async () => {
    const { result } = renderHook(() => useAddWorkspaceFiles());
    await act(() => result.current.addFiles([file('a.raw'), file('b.xlsx')]));
    expect(loadCase).not.toHaveBeenCalled();
    expect(actionOf(success)).toBeUndefined();
  });

  it('offers to open the case, rather than open it, when another case is open', async () => {
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('kundur.raw'), addfiles: [] },
    });
    const { result } = renderHook(() => useAddWorkspaceFiles());
    await act(() => result.current.addFiles([file('ieee14.raw'), file('ieee14.dyr')]));
    expect(loadCase).not.toHaveBeenCalled();
    const action = actionOf(success);
    expect(action?.label).toBe('Open');
    await act(async () => {
      action?.onClick();
      await Promise.resolve();
    });
    expect(loadCase.mock.calls[0]?.[0]).toEqual({
      sessionId: 's1',
      request: { primary_path: 'ieee14.raw', addfiles: ['ieee14.dyr'] },
    });
  });

  it('offers to open, rather than starts a second load, while a case is still loading', async () => {
    useCaseStore.setState({ selection: null, loadingPath: 'kundur.raw' });
    const { result } = renderHook(() => useAddWorkspaceFiles());
    await act(() => result.current.addFiles([file('ieee14.raw')]));
    useCaseStore.setState({ loadingPath: null });
    expect(loadCase).not.toHaveBeenCalled();
    expect(actionOf(success)?.label).toBe('Open');
  });

  it('opens and offers nothing without a session', async () => {
    useSessionStore.setState({ sessionId: null });
    const { result } = renderHook(() => useAddWorkspaceFiles());
    await act(() => result.current.addFiles([file('ieee14.raw')]));
    expect(loadCase).not.toHaveBeenCalled();
    expect(success).toHaveBeenCalledTimes(1);
    expect(actionOf(success)).toBeUndefined();
  });

  it('does not send a file the server is bound to refuse, and says why', async () => {
    const { result } = renderHook(() => useAddWorkspaceFiles());
    await act(() => result.current.addFiles([file('notes.txt')]));
    expect(upload).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('notes.txt is not a case file'));

    await act(() => result.current.addFiles([file('empty.raw', '')]));
    expect(error).toHaveBeenLastCalledWith('empty.raw is empty.');

    const huge = file('huge.raw');
    Object.defineProperty(huge, 'size', { value: MAX_CASE_UPLOAD_BYTES + 1 });
    await act(() => result.current.addFiles([huge]));
    expect(error).toHaveBeenLastCalledWith('huge.raw is larger than 32 MiB.');
    expect(upload).not.toHaveBeenCalled();
  });

  it('adds the files that can be and reports the ones that cannot in a single toast', async () => {
    const { result } = renderHook(() => useAddWorkspaceFiles());
    await act(() =>
      result.current.addFiles([file('a.dyr'), file('x.txt'), file('y.zip'), file('b.dyr')]),
    );
    expect(upload).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('2 files were not added.', {
      description: expect.stringContaining('x.txt is not a case file'),
    });
    expect(success).toHaveBeenCalledWith('Added 2 files to the workspace.', {
      description: 'a.dyr and b.dyr',
    });
  });

  it('says why the server refused a file, and goes on with the rest', async () => {
    upload.mockImplementation(({ file: f }: { file: File }) =>
      f.name === 'CON.raw'
        ? Promise.reject(problem(400, "unsafe file name 'CON.raw': the name is a reserved device"))
        : Promise.resolve(stored(f.name)),
    );
    const { result } = renderHook(() => useAddWorkspaceFiles());
    await act(() => result.current.addFiles([file('CON.raw'), file('a.dyr')]));
    expect(error).toHaveBeenCalledWith(
      "Could not add CON.raw: unsafe file name 'CON.raw': the name is a reserved device",
    );
    expect(success).toHaveBeenCalledWith('Added a.dyr to the workspace.', {
      description: undefined,
    });
  });

  it('names a failure that is not a problem document by its message', async () => {
    upload.mockRejectedValueOnce(new Error('Network error on POST /api/workspace/files'));
    const { result } = renderHook(() => useAddWorkspaceFiles());
    await act(() => result.current.addFiles([file('a.dyr')]));
    expect(error).toHaveBeenCalledWith(
      'Could not add a.dyr: Network error on POST /api/workspace/files',
    );
  });

  describe('a name that is already in the workspace', () => {
    beforeEach(() => {
      upload.mockImplementation(({ file: f, overwrite }: { file: File; overwrite?: boolean }) =>
        f.name === 'ieee14.raw' && !overwrite
          ? Promise.reject(problem(409, "'ieee14.raw' already exists in the workspace"))
          : Promise.resolve({ ...stored(f.name), replaced: overwrite === true }),
      );
    });

    it('is left alone, with a Replace button that sends it again over the old one', async () => {
      const { result } = renderHook(() => useAddWorkspaceFiles());
      const f = file('ieee14.raw');
      await act(() => result.current.addFiles([f, file('b.xlsx')]));
      expect(warning).toHaveBeenCalledWith(
        'ieee14.raw is already in the workspace.',
        expect.objectContaining({ duration: 15_000 }),
      );
      // The other file was added all the same. The taken case counts as dropped, so
      // two cases came together and neither opens.
      expect(success).toHaveBeenCalledWith('Added b.xlsx to the workspace.', expect.anything());
      expect(loadCase).not.toHaveBeenCalled();
      expect(upload).toHaveBeenCalledTimes(2);

      const action = actionOf(warning);
      expect(action?.label).toBe('Replace');
      await act(async () => {
        action?.onClick();
        await Promise.resolve();
      });
      expect(upload).toHaveBeenLastCalledWith({ file: f, overwrite: true });
      expect(success).toHaveBeenLastCalledWith('Replaced ieee14.raw in the workspace.', {
        description: undefined,
      });
    });

    it('opens the case it replaced when nothing is open', async () => {
      const { result } = renderHook(() => useAddWorkspaceFiles());
      await act(() => result.current.addFiles([file('ieee14.raw')]));
      await act(async () => {
        actionOf(warning)?.onClick();
        await Promise.resolve();
      });
      expect(loadCase.mock.calls[0]?.[0]).toMatchObject({
        request: { primary_path: 'ieee14.raw' },
      });
    });

    it('warns that the open case still holds the old copy, with a button that reloads it', async () => {
      useCaseStore.setState({
        selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
      });
      const { result } = renderHook(() => useAddWorkspaceFiles());
      await act(() => result.current.addFiles([file('ieee14.raw')]));
      await act(async () => {
        actionOf(warning)?.onClick();
        await Promise.resolve();
      });
      expect(warning).toHaveBeenLastCalledWith(
        'Replaced ieee14.raw. The open case still holds the old copy.',
        expect.objectContaining({ action: expect.objectContaining({ label: 'Reload case' }) }),
      );
      expect(reload).not.toHaveBeenCalled();
      act(() => actionOf(warning)?.onClick());
      expect(reload).toHaveBeenCalledWith('s1');
      expect(loadCase).not.toHaveBeenCalled();
    });

    it('says when a replacement fails', async () => {
      const { result } = renderHook(() => useAddWorkspaceFiles());
      await act(() => result.current.addFiles([file('ieee14.raw')]));
      upload.mockRejectedValueOnce(problem(500, 'disk full'));
      await act(async () => {
        actionOf(warning)?.onClick();
        await Promise.resolve();
      });
      expect(error).toHaveBeenLastCalledWith('Could not replace ieee14.raw: disk full');
    });
  });

  describe('a drop where only some of the names are taken', () => {
    /** An upload that answers 409 for the names in `taken` until they are replaced. */
    function taking(...taken: string[]) {
      upload.mockImplementation(({ file: f, overwrite }: { file: File; overwrite?: boolean }) =>
        taken.includes(f.name) && !overwrite
          ? Promise.reject(problem(409, `'${f.name}' already exists in the workspace`))
          : Promise.resolve({ ...stored(f.name), replaced: overwrite === true }),
      );
    }
    const pair = { primary_path: 'x.raw', addfiles: ['x.dyr'] };

    it('opens a new .raw with the .dyr that is already there, and says the .dyr is the old copy once replaced', async () => {
      taking('x.dyr');
      const { result } = renderHook(() => useAddWorkspaceFiles());
      await act(() => result.current.addFiles([file('x.raw'), file('x.dyr')]));
      expect(loadCase).toHaveBeenCalledTimes(1);
      expect(loadCase.mock.calls[0]?.[0]).toEqual({ sessionId: 's1', request: pair });
      expect(success).toHaveBeenCalledWith('Added x.raw to the workspace.', expect.anything());
      expect(warning).toHaveBeenCalledWith(
        'x.dyr is already in the workspace.',
        expect.objectContaining({ action: expect.objectContaining({ label: 'Replace' }) }),
      );

      // Replace the .dyr that the open case was loaded with: the case holds the old one.
      await act(async () => {
        actionLabelled(warning, 'Replace')?.onClick();
        await Promise.resolve();
      });
      expect(warning).toHaveBeenLastCalledWith(
        'Replaced x.dyr. The open case still holds the old copy.',
        expect.objectContaining({ action: expect.objectContaining({ label: 'Reload case' }) }),
      );
      act(() => actionLabelled(warning, 'Reload case')?.onClick());
      expect(reload).toHaveBeenCalledWith('s1');
    });

    it('offers to open the new .raw with the .dyr that is already there when another case is open', async () => {
      taking('x.dyr');
      useCaseStore.setState({
        selection: { primaryPath: parseWorkspacePath('kundur.raw'), addfiles: [] },
      });
      const { result } = renderHook(() => useAddWorkspaceFiles());
      await act(() => result.current.addFiles([file('x.raw'), file('x.dyr')]));
      expect(loadCase).not.toHaveBeenCalled();
      await act(async () => {
        actionLabelled(success, 'Open')?.onClick();
        await Promise.resolve();
      });
      expect(loadCase.mock.calls[0]?.[0]).toEqual({ sessionId: 's1', request: pair });
    });

    it('opens a .raw that is already there with the new .dyr dropped with it', async () => {
      taking('x.raw');
      const { result } = renderHook(() => useAddWorkspaceFiles());
      await act(() => result.current.addFiles([file('x.raw'), file('x.dyr')]));
      expect(success).toHaveBeenCalledWith('Added x.dyr to the workspace.', expect.anything());
      expect(loadCase.mock.calls[0]?.[0]).toEqual({ sessionId: 's1', request: pair });
      expect(warning).toHaveBeenCalledWith(
        'x.raw is already in the workspace.',
        expect.objectContaining({ action: expect.objectContaining({ label: 'Replace' }) }),
      );
    });

    it('offers the .raw it replaced together with the .dyr that came with it, not on its own', async () => {
      taking('x.raw');
      useCaseStore.setState({
        selection: { primaryPath: parseWorkspacePath('kundur.raw'), addfiles: [] },
      });
      const { result } = renderHook(() => useAddWorkspaceFiles());
      await act(() => result.current.addFiles([file('x.raw'), file('x.dyr')]));
      await act(async () => {
        actionLabelled(warning, 'Replace')?.onClick();
        await Promise.resolve();
      });
      expect(success).toHaveBeenLastCalledWith(
        'Replaced x.raw in the workspace.',
        expect.anything(),
      );
      expect(loadCase).not.toHaveBeenCalled();
      await act(async () => {
        actionLabelled(success, 'Open')?.onClick();
        await Promise.resolve();
      });
      expect(loadCase.mock.calls[0]?.[0]).toEqual({ sessionId: 's1', request: pair });
    });

    it('opens nothing when the whole pair is taken, until it is replaced, and then opens the pair', async () => {
      taking('x.raw', 'x.dyr');
      const { result } = renderHook(() => useAddWorkspaceFiles());
      await act(() => result.current.addFiles([file('x.raw'), file('x.dyr')]));
      expect(loadCase).not.toHaveBeenCalled();
      expect(success).not.toHaveBeenCalled();
      await act(async () => {
        actionLabelled(warning, 'Replace')?.onClick();
        await Promise.resolve();
      });
      expect(success).toHaveBeenLastCalledWith('Replaced 2 files in the workspace.', {
        description: 'x.raw and x.dyr',
      });
      expect(loadCase.mock.calls[0]?.[0]).toEqual({ sessionId: 's1', request: pair });
    });
  });

  describe('a toast button that is pressed later', () => {
    const other = { primaryPath: parseWorkspacePath('kundur.raw'), addfiles: [] };

    it('opens in the session that is current when it is pressed', async () => {
      useCaseStore.setState({ selection: other });
      const { result } = renderHook(() => useAddWorkspaceFiles());
      await act(() => result.current.addFiles([file('ieee14.raw')]));
      const open = actionLabelled(success, 'Open');
      // The session is recreated while the toast is up.
      act(() => useSessionStore.setState({ sessionId: parseSessionId('s2') }));
      await act(async () => {
        open?.onClick();
        await Promise.resolve();
      });
      expect(loadCase.mock.calls[0]?.[0]).toMatchObject({ sessionId: 's2' });
    });

    it('does not load a case that has been opened since', async () => {
      useCaseStore.setState({ selection: other });
      const { result } = renderHook(() => useAddWorkspaceFiles());
      await act(() => result.current.addFiles([file('ieee14.raw')]));
      const open = actionLabelled(success, 'Open');
      act(() =>
        useCaseStore.setState({
          selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
        }),
      );
      await act(async () => {
        open?.onClick();
        await Promise.resolve();
      });
      expect(loadCase).not.toHaveBeenCalled();
    });

    const stale = {
      selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
    };

    async function replaceOpenCase() {
      upload.mockImplementation(({ file: f, overwrite }: { file: File; overwrite?: boolean }) =>
        overwrite
          ? Promise.resolve({ ...stored(f.name), replaced: true })
          : Promise.reject(problem(409, 'taken')),
      );
      useCaseStore.setState(stale);
      const { result } = renderHook(() => useAddWorkspaceFiles());
      await act(() => result.current.addFiles([file('ieee14.raw')]));
      await act(async () => {
        actionLabelled(warning, 'Replace')?.onClick();
        await Promise.resolve();
      });
      return actionLabelled(warning, 'Reload case');
    }

    it('reloads in the session that is current when it is pressed', async () => {
      const reloadAction = await replaceOpenCase();
      act(() => useSessionStore.setState({ sessionId: parseSessionId('s2') }));
      act(() => reloadAction?.onClick());
      expect(reload).toHaveBeenCalledWith('s2');
    });

    it('does not reload a different case that was opened since', async () => {
      const reloadAction = await replaceOpenCase();
      act(() => useCaseStore.setState({ selection: other }));
      act(() => reloadAction?.onClick());
      expect(reload).not.toHaveBeenCalled();
    });

    it('does not reload when the session has gone', async () => {
      const reloadAction = await replaceOpenCase();
      act(() => useSessionStore.setState({ sessionId: null }));
      act(() => reloadAction?.onClick());
      expect(reload).not.toHaveBeenCalled();
    });
  });
});
