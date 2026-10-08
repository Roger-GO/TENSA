import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { useListWorkspaceFiles } from '@/api/queries';
import { cn } from '@/lib/cn';
import { useOpenCase } from '@/lib/openCase';
import { baseName } from '@/lib/paths';
import { useReloadedCaseStore, type CaseOnFile } from '@/store/reloadedCase';
import { useSessionStore } from '@/store/session';

/**
 * Says that a reload of the page closed the case, and reopens it.
 *
 * A reload starts an empty session, so the page comes up with no case, and it
 * read exactly as it does on a first visit: "No case loaded", with the case
 * that had been open somewhere among the saved ones. This names the file the
 * tab had open (`store/reloadedCase.ts`) and opens it again in one click, with
 * the dynamic files it was opened with, the way a row of the Recent list does.
 *
 * It is drawn where a case is looked for when none is open: over the empty
 * diagram, in the Case section of the sidebar's Project tab, and above the
 * palette of its Components tab, since the sidebar opens on the tab it was
 * left on. It draws nothing on a first visit or once a case is open again, and
 * a file the workspace no longer holds is forgotten.
 */
export interface ReloadedCaseNoteProps {
  /**
   * Where it is drawn, which sets how it is laid out (centred over the diagram,
   * from the left edge in the sidebar) and the suffix of its test ids.
   */
  placement: 'diagram' | 'project' | 'components';
  className?: string;
}

export function ReloadedCaseNote({ placement, className }: ReloadedCaseNoteProps) {
  const closed = useReloadedCaseStore((s) => s.closed);
  // Nothing to say on a first visit or with a case open, and then nothing is
  // asked of the server either: that is the part below.
  if (closed === null) return null;
  return <Note closed={closed} placement={placement} className={className} />;
}

interface NoteProps extends ReloadedCaseNoteProps {
  closed: CaseOnFile;
}

function Note({ closed, placement, className }: NoteProps) {
  const sessionId = useSessionStore((s) => s.sessionId);
  const forget = useReloadedCaseStore((s) => s.forget);
  const filesQuery = useListWorkspaceFiles();
  const { openCase, isPending } = useOpenCase();

  // Offered while the workspace holds the file, with the dynamic files that
  // are still there, as the Recent list does. Until the listing is in, the
  // file is taken to be there: a reload should say at once what it closed.
  const files = filesQuery.data?.files;
  const gone = files !== undefined && !files.some((f) => f.name === closed.primaryPath);
  useEffect(() => {
    if (gone) forget();
  }, [gone, forget]);
  if (gone) return null;
  const addfiles =
    files === undefined
      ? closed.addfiles
      : closed.addfiles.filter((a) => files.some((f) => f.name === a));

  const name = baseName(closed.primaryPath);
  const waiting = sessionId === null;
  // Over the empty diagram it is the sentence and the button of that empty
  // state, and no taller than the sentence for a first visit, which it stands
  // in for: the page must not grow under the first-run card for it. In the
  // sidebar it is a box of its own among the other lines.
  const centred = placement === 'diagram';
  return (
    <div
      role="group"
      aria-label="Case closed by the reload"
      data-testid={`reloaded-case-note-${placement}`}
      className={cn(
        'flex flex-col',
        centred
          ? 'max-w-xs items-center gap-3'
          : 'border-border bg-muted/30 items-start gap-2 rounded border px-2 py-2',
        className,
      )}
    >
      <p
        className={
          centred
            ? 'text-muted-foreground text-[13px] leading-relaxed'
            : 'text-foreground text-[11px] leading-snug'
        }
      >
        A reload of the page closes the open case.{' '}
        <span className="text-foreground font-mono font-medium break-words">{name}</span> was open
        {addfiles.length > 0 ? `, with ${addfiles.map(baseName).join(', ')}` : ''}.
      </p>
      <Button
        type="button"
        variant={centred ? 'primary' : 'outline'}
        size="sm"
        disabled={waiting || isPending}
        title={waiting ? 'The server session is not ready yet.' : undefined}
        onClick={() => openCase(closed.primaryPath, addfiles)}
        data-testid={`reloaded-case-reopen-${placement}`}
        className="max-w-full"
      >
        <span className="truncate">Reopen {name}</span>
      </Button>
    </div>
  );
}
