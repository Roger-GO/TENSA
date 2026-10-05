import { useEffect, useRef, useState } from 'react';
import { CASE_FILE_EXTENSIONS, MAX_CASE_UPLOAD_BYTES } from '@/lib/caseUpload';
import { useAddWorkspaceFiles } from '@/lib/useAddWorkspaceFiles';

/**
 * WorkspaceDropTarget. Drop case files anywhere on the window to add them to the
 * workspace (`useAddWorkspaceFiles` says what became of them). Mounted once, from
 * `App.tsx`.
 *
 * Only a drag that carries files is taken (a Component library tile carries its
 * own type and goes on to the canvas's drop zone), and a drag over a file input is
 * left to the input, which takes a drop itself. Claiming the drag at all matters
 * as much as acting on it: a drop the page does not cancel makes the browser leave
 * the app to show the file, and with it the case, the runs and the plots.
 *
 * While files are over the window a hint covers it. The drag events fire on every
 * element the pointer crosses, so enters and leaves are counted: the hint goes
 * when the count is back to zero, on a drop, or when the drag ends elsewhere.
 */
function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

function overFileInput(event: DragEvent): boolean {
  return event.target instanceof Element && event.target.closest('input[type="file"]') !== null;
}

export function WorkspaceDropTarget() {
  const { addFiles } = useAddWorkspaceFiles();
  const [dragging, setDragging] = useState(false);

  const latest = useRef(addFiles);
  useEffect(() => {
    latest.current = addFiles;
  });

  useEffect(() => {
    let depth = 0;
    const end = () => {
      depth = 0;
      setDragging(false);
    };
    const onDragEnter = (event: DragEvent) => {
      if (!hasFiles(event) || overFileInput(event)) return;
      event.preventDefault();
      depth += 1;
      setDragging(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event) || overFileInput(event)) return;
      // Without this the browser shows "no drop" and never fires `drop`.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (event: DragEvent) => {
      if (!hasFiles(event) || overFileInput(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event) || overFileInput(event)) return;
      event.preventDefault();
      end();
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) void latest.current(files);
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragend', end);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragend', end);
    };
  }, []);

  if (!dragging) return null;
  return (
    <div
      data-testid="workspace-drop-overlay"
      className="bg-background/70 pointer-events-none fixed inset-0 z-50 flex items-center justify-center"
    >
      <div className="border-primary bg-background rounded-[var(--radius-lg)] border-2 border-dashed px-8 py-6 text-center shadow-lg">
        <p role="status" className="text-foreground text-sm font-medium">
          Drop to add to the workspace
        </p>
        <p className="text-muted-foreground mt-1 text-xs">
          {CASE_FILE_EXTENSIONS.join(', ')} files, up to {MAX_CASE_UPLOAD_BYTES / (1024 * 1024)} MiB
          each
        </p>
      </div>
    </div>
  );
}
