/**
 * OpenCasePage: the palette's second page, the case files of the workspace.
 *
 * "Open case" (the workspace menu, the palette, Ctrl/Cmd+O) switches the palette
 * from its command list to this: type to filter by file name, arrow keys and
 * Enter to pick, and the case loads the way a click in the sidebar's saved-cases
 * list loads it (`useOpenCase`). Backspace on an empty input, or the button,
 * goes back to the commands.
 *
 * It is its own cmdk root because cmdk filters the items of one root, and the
 * two pages have nothing in common but the look.
 */
import { Command as CmdkCommand } from 'cmdk';

import { useListWorkspaceFiles } from '@/api/queries';
import { cn } from '@/lib/cn';
import { isPrimaryCase, useOpenCase } from '@/lib/openCase';
import { useCaseStore } from '@/store/case';
import { useCommandPaletteStore } from '@/store/commandPalette';

export function OpenCasePage() {
  const filesQuery = useListWorkspaceFiles();
  const { openCase } = useOpenCase();
  const current = useCaseStore((s) => s.selection?.primaryPath ?? null);
  const setPage = useCommandPaletteStore((s) => s.setPage);
  const closePalette = useCommandPaletteStore((s) => s.closePalette);

  const files = (filesQuery.data?.files ?? []).filter(isPrimaryCase);

  return (
    <CmdkCommand
      label="Open case"
      loop
      data-testid="command-palette-open-case"
      className="flex max-h-[60vh] flex-col"
    >
      <div className="border-border flex items-center border-b pr-2">
        <CmdkCommand.Input
          autoFocus
          data-testid="command-palette-input"
          placeholder="Open case: type a file name…"
          onKeyDown={(event) => {
            if (event.key === 'Backspace' && event.currentTarget.value === '') {
              event.preventDefault();
              setPage('commands');
            }
          }}
          className={cn(
            'w-full min-w-0 flex-1 bg-transparent px-3.5 py-3.5 text-sm',
            'placeholder:text-muted-foreground/70',
            'focus:outline-none',
          )}
        />
        <button
          type="button"
          data-testid="command-palette-back"
          onClick={() => setPage('commands')}
          className={cn(
            'text-muted-foreground hover:text-foreground shrink-0 rounded px-2 py-1 text-xs',
            'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
          )}
        >
          All commands
        </button>
      </div>

      <CmdkCommand.List className="flex-1 overflow-auto p-1">
        {filesQuery.isPending ? (
          <div
            data-testid="command-palette-open-case-loading"
            className="text-muted-foreground px-3 py-6 text-center text-sm"
          >
            Listing the workspace…
          </div>
        ) : filesQuery.isError ? (
          <div
            role="alert"
            data-testid="command-palette-open-case-error"
            className="text-muted-foreground px-3 py-6 text-center text-sm"
          >
            Could not list the workspace files: {filesQuery.error.message}
          </div>
        ) : files.length === 0 ? (
          <div
            data-testid="command-palette-open-case-none"
            className="text-muted-foreground px-3 py-6 text-center text-sm"
          >
            No case files in the workspace. Drop a .raw, .xlsx, .json or .m file on the window, or
            put one in the workspace folder.
          </div>
        ) : (
          <>
            <CmdkCommand.Empty
              data-testid="command-palette-empty"
              className="text-muted-foreground px-3 py-6 text-center text-sm"
            >
              No case file matches.
            </CmdkCommand.Empty>
            <CmdkCommand.Group
              heading="Workspace"
              className={cn(
                '[&_[cmdk-group-heading]]:text-muted-foreground',
                '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1',
                '[&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-medium',
                '[&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:uppercase',
              )}
            >
              {files.map((file) => (
                <CmdkCommand.Item
                  key={file.name}
                  value={file.name}
                  onSelect={() => {
                    // Close first: the load is a request, and its failure is a toast.
                    closePalette();
                    openCase(file.name);
                  }}
                  data-testid={`open-case-item-${file.name}`}
                  className={cn(
                    'flex cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-sm',
                    'data-[selected=true]:bg-muted aria-selected:bg-muted',
                    'outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]',
                  )}
                >
                  <span className="flex-1 truncate font-mono">{file.name}</span>
                  {file.name === current ? (
                    <span className="text-primary shrink-0 text-[10px]">open now</span>
                  ) : null}
                  <span className="text-muted-foreground shrink-0 font-mono text-[10px]">
                    {file.format.toUpperCase()}
                  </span>
                </CmdkCommand.Item>
              ))}
            </CmdkCommand.Group>
          </>
        )}
      </CmdkCommand.List>
    </CmdkCommand>
  );
}
