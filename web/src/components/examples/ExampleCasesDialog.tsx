import { useRef, useState } from 'react';
import { useListExamples, useReloadCase } from '@/api/queries';
import type { ExampleListEntry } from '@/api/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/Input';
import {
  CASE_CATEGORIES,
  LINK_ONLY_GROUP,
  casesOfCategory,
  companionFileNames,
  countText,
  isLinkOnly,
  matchesFilter,
  primaryFileName,
  workspaceNote,
} from '@/lib/exampleCases';
import { describeError } from '@/lib/describeError';
import { useOpenCase } from '@/lib/openCase';
import { useCaseStore } from '@/store/case';
import { useExampleCasesStore } from '@/store/exampleCases';
import { useSessionStore } from '@/store/session';
import { ExampleCard } from './ExampleCard';

/**
 * ExampleCasesDialog: the example cases of the catalog, to add to the workspace and open.
 *
 * Opened from the Project tab, the empty states and the command palette (all through
 * `useExampleCasesStore`). The catalog is read from the server each time it opens, since
 * the workspace may have changed, and the cards are grouped by what the case supports:
 * dynamic cases (with machine models) and steady-state ones (a network, for power flow), and
 * then the entries that are only links to data TENSA does not hold.
 * A filter narrows them by name, size or analysis, and a line under it says how many are in
 * the workspace already (a new workspace starts with the default set, so most cards open as
 * Added, and the first-time user is told why and what to press). Adding a case copies its file into the
 * workspace and writes where it came from beside it; opening one loads it as the case of
 * the session, exactly as a click on its row in the Project tab does, and closes the
 * dialog so the diagram is what the user sees.
 *
 * When it closes, the keyboard focus goes back to what had it when it opened (Radix
 * returns it to a trigger, and this dialog has none), else to the Project tab.
 */
export function ExampleCasesDialog() {
  const open = useExampleCasesStore((s) => s.dialogOpen);
  const closeDialog = useExampleCasesStore((s) => s.closeDialog);
  const opener = useRef<HTMLElement | null>(null);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) closeDialog();
      }}
    >
      <DialogContent
        data-testid="example-cases-dialog"
        // The width goes through ``widthClassName`` (as a class it would tie with the
        // default width). The dialog has the one height, held to the window's, and its
        // cards scroll inside it: the title, the filter and Close stay in reach, and the
        // filter does not move as the list under it shrinks to what was typed.
        widthClassName="max-w-[min(48rem,calc(100vw-2rem))]"
        className="flex h-[min(48rem,calc(100vh-2rem))] flex-col"
        onOpenAutoFocus={() => {
          // Before the focus moves into the dialog: what has it now.
          const active = document.activeElement;
          opener.current =
            active instanceof HTMLElement && active !== document.body ? active : null;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const back = opener.current;
          opener.current = null;
          const target =
            back !== null && back.isConnected
              ? back
              : document.querySelector<HTMLElement>('[data-testid="left-sidebar-tab-project"]');
          target?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Example cases</DialogTitle>
          <DialogDescription>
            Ready-made power systems to study. Add one to copy its file into your workspace, then
            open it. Where each came from, how to cite it and its licence are written to{' '}
            <code className="font-mono text-xs">EXAMPLE-SOURCES.md</code> beside it.
          </DialogDescription>
        </DialogHeader>
        <Body />
        <DialogFooter className="mt-4">
          <DialogClose asChild>
            <Button type="button" variant="outline" data-testid="example-cases-close">
              Close
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The part that needs the server: mounted with the dialog's content, so the catalog is read
 * afresh each time. The filter is drawn before the catalog arrives, so the dialog opens with
 * the keyboard focus in it, ready to type, whether or not the list has come yet.
 */
function Body() {
  const list = useListExamples();
  const closeDialog = useExampleCasesStore((s) => s.closeDialog);
  const sessionId = useSessionStore((s) => s.sessionId);
  const openPath = useCaseStore((s) => s.selection?.primaryPath ?? null);
  const loadingPath = useCaseStore((s) => s.loadingPath);
  const { openCase, isPending: loadPending } = useOpenCase();
  const reloadCase = useReloadCase();
  const [filter, setFilter] = useState('');

  const openBlocked =
    sessionId === null
      ? 'Waiting for the server to start a session, which opening a case needs.'
      : loadPending || loadingPath !== null
        ? 'Another case is loading.'
        : null;

  // The open case read again from its file, which an example card has just replaced.
  const onReload = () => {
    if (sessionId !== null) reloadCase.mutate(sessionId);
  };

  const onOpen = (example: ExampleListEntry) => {
    const primary = primaryFileName(example);
    if (primary === null) return;
    openCase(primary, companionFileNames(example));
    // The case loads while the diagram is shown: the notice says it is open.
    closeDialog();
  };

  const examples = list.data?.examples ?? [];
  const shown = examples.filter((example) => matchesFilter(example, filter));
  // A card that does not match is hidden, not taken out of the page, so what a user had
  // opened in it (its references, its notes) is still there when the filter lets it back.
  const shownIds = new Set(shown.map((example) => example.id));
  const note = workspaceNote(examples);
  // The cases of each category, and after them the entries that are only links.
  const groups = [
    ...CASE_CATEGORIES.map((category) => ({
      value: category.value,
      heading: category.heading,
      blurb: category.blurb,
      members: casesOfCategory(examples, category.value),
    })),
    { ...LINK_ONLY_GROUP, members: examples.filter(isLinkOnly) },
  ];

  return (
    <div className="mt-3 flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center gap-3">
        <Input
          type="search"
          value={filter}
          onChange={setFilter}
          aria-label="Filter the example cases"
          placeholder="Filter by name, size or analysis"
          data-testid="example-cases-filter"
          className="min-w-0 flex-1"
        />
        <p
          role="status"
          data-testid="example-cases-count"
          className="text-muted-foreground shrink-0 text-xs"
        >
          {list.data === undefined ? '' : countText(examples, shown.length, filter.trim() !== '')}
        </p>
      </div>

      {/* Under the filter, not above it: the note comes with the list, and the filter, which has
          the cursor, must not move when it arrives. */}
      {list.data !== undefined && note !== null ? (
        <p
          data-testid="example-cases-workspace-note"
          className="text-muted-foreground text-xs leading-snug"
        >
          {note}
        </p>
      ) : null}

      <div data-testid="example-cases-scroll" className="min-h-0 flex-1 overflow-y-auto pr-1">
        {list.isPending ? (
          <p
            role="status"
            data-testid="example-cases-loading"
            className="text-muted-foreground py-8 text-center text-sm"
          >
            Loading the example cases…
          </p>
        ) : list.isError ? (
          <div
            role="alert"
            data-testid="example-cases-error"
            className="flex flex-col items-center gap-2 py-8 text-center text-sm"
          >
            <p className="text-foreground">
              Could not load the example cases: {describeError(list.error)}
            </p>
            <Button type="button" variant="outline" size="sm" onClick={() => void list.refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <>
            {shown.length === 0 ? (
              <div
                data-testid="example-cases-none"
                className="text-muted-foreground flex flex-col items-center gap-2 py-8 text-center text-sm"
              >
                <p>
                  {examples.length === 0
                    ? 'This server has no example cases.'
                    : `No example case matches “${filter.trim()}”.`}
                </p>
                {examples.length > 0 ? (
                  <Button type="button" variant="outline" size="sm" onClick={() => setFilter('')}>
                    Clear the filter
                  </Button>
                ) : null}
              </div>
            ) : null}
            <div hidden={shown.length === 0} className="flex flex-col gap-5">
              {groups.map((group) => {
                if (group.members.length === 0) return null;
                return (
                  <section
                    key={group.value}
                    hidden={!group.members.some((example) => shownIds.has(example.id))}
                    aria-labelledby={`example-group-${group.value}`}
                    data-testid={`example-group-${group.value}`}
                    className="flex flex-col gap-2"
                  >
                    <div>
                      <h3
                        id={`example-group-${group.value}`}
                        className="text-foreground text-sm font-semibold"
                      >
                        {group.heading}
                      </h3>
                      <p className="text-muted-foreground text-xs">{group.blurb}</p>
                    </div>
                    <ul className="flex flex-col gap-2" role="list">
                      {group.members.map((example) => (
                        <li key={example.id} hidden={!shownIds.has(example.id)}>
                          <ExampleCard
                            example={example}
                            openPath={openPath}
                            openBlocked={openBlocked}
                            onOpen={onOpen}
                            onReload={onReload}
                          />
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
