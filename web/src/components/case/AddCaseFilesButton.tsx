import { useRef } from 'react';
import type { ChangeEvent } from 'react';
import { CASE_FILE_ACCEPT } from '@/lib/caseUpload';
import { useAddWorkspaceFiles } from '@/lib/useAddWorkspaceFiles';
import { cn } from '@/lib/cn';

/**
 * AddCaseFilesButton. Opens the browser's file chooser and adds the files picked
 * to the workspace: the same as dropping them on the window, for anyone who does
 * not drag. Several files may be picked at once (a `.raw` with its `.dyr`).
 *
 * What becomes of each file (added, refused and why, already there) is reported
 * by `useAddWorkspaceFiles` in toasts.
 */
export interface AddCaseFilesButtonProps {
  className?: string;
}

export function AddCaseFilesButton({ className }: AddCaseFilesButtonProps) {
  const { addFiles, isUploading } = useAddWorkspaceFiles();
  const inputRef = useRef<HTMLInputElement>(null);

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []);
    // Clear the input so choosing the same file again fires another change.
    input.value = '';
    if (files.length > 0) void addFiles(files);
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={CASE_FILE_ACCEPT}
        hidden
        tabIndex={-1}
        aria-label="Case files to add to the workspace"
        data-testid="add-case-files-input"
        onChange={onChange}
      />
      <button
        type="button"
        data-testid="add-case-files"
        disabled={isUploading}
        onClick={() => inputRef.current?.click()}
        title="Add .raw, .dyr, .m, .xlsx or .json files to the workspace. You can also drop them anywhere in this window."
        className={cn(
          'text-primary rounded-[var(--radius-sm)] px-1.5 py-0.5 hover:underline',
          'text-[10px] font-medium tracking-wide',
          'transition-colors duration-[var(--duration-fast)]',
          'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
          'disabled:cursor-not-allowed disabled:opacity-60',
          className,
        )}
      >
        {isUploading ? 'Adding…' : 'Add files…'}
      </button>
    </>
  );
}
