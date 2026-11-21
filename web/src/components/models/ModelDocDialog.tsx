import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ProblemDetailsError } from '@/api/client';
import { useModelDoc, useSupportedModels } from '@/api/queries';
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
import { cn } from '@/lib/cn';
import { useModelDocStore } from '@/store/modelDoc';

/**
 * ModelDocDialog. ANDES's own documentation of its models, as plain text.
 *
 * Two modes: opened from a form's button it shows the documentation of that
 * model; opened from the command palette (``model === null``) it lists every
 * model ANDES ships by group, searchable, and shows the documentation of the
 * one that is picked. The text is rendered as it was sent, never as HTML, in
 * a block that scrolls inside the dialog, and the dialog is held inside the
 * window however long the text is.
 *
 * When it closes, the keyboard focus goes back to what had it when it opened
 * (Radix returns it to a trigger, and this dialog has none), as the Example
 * cases dialog does.
 */
export function ModelDocDialog() {
  const dialogOpen = useModelDocStore((s) => s.dialogOpen);
  const model = useModelDocStore((s) => s.model);
  const closeDialog = useModelDocStore((s) => s.closeDialog);
  const opener = useRef<HTMLElement | null>(null);
  return (
    <Dialog
      open={dialogOpen}
      onOpenChange={(o) => {
        if (!o) closeDialog();
      }}
    >
      <DialogContent
        widthClassName="max-w-[min(56rem,calc(100vw-2rem))]"
        className="flex max-h-[calc(100vh-2rem)] flex-col gap-4"
        data-testid="model-doc-dialog"
        onOpenAutoFocus={() => {
          // Before the focus moves into the dialog: what has it now.
          const active = document.activeElement;
          if (active instanceof HTMLElement && active !== document.body) opener.current = active;
        }}
        onCloseAutoFocus={(event) => {
          // A close is handled a tick after the dialog left the page, and by
          // then it may be open again: that opening owns the focus.
          if (useModelDocStore.getState().dialogOpen) return;
          const back = opener.current;
          opener.current = null;
          if (back !== null && back.isConnected) {
            event.preventDefault();
            back.focus();
          }
        }}
      >
        {/* Radix unmounts the content when the dialog closes, so the search
            and the pick of browse mode start afresh on the next open. */}
        {model === null ? <BrowseBody /> : <DirectBody model={model} />}
        <DialogFooter className="mt-0">
          <DialogClose asChild>
            <Button type="button" variant="outline" data-testid="model-doc-close">
              Close
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The sentence for a session whose engine has no model documentation. */
const OTHER_ENGINE = 'Only ANDES documents its models, and this session runs another engine.';

/** A 409 that is not the session being busy: the engine documents no models. */
function isOtherEngine(error: Error | null): boolean {
  return (
    error instanceof ProblemDetailsError &&
    error.status === 409 &&
    error.recovery?.kind !== 'wait-for-job'
  );
}

/** What is added to a failure when the session stayed busy through every retry. */
function busyNote(error: Error | null): string {
  return error instanceof ProblemDetailsError &&
    error.status === 409 &&
    error.recovery?.kind === 'wait-for-job'
    ? ' The session is busy with another operation; open it again once that is done.'
    : '';
}

/** The header, and which of the two modes the body is. */
function Header({ model }: { model: string | null }) {
  return (
    <DialogHeader>
      <DialogTitle data-testid="model-doc-title">
        Model documentation
        {model !== null ? <span className="font-mono"> {model}</span> : null}
      </DialogTitle>
      <DialogDescription>
        {model === null
          ? 'Every model ANDES ships, by group. Pick one to read ANDES’s documentation of it.'
          : 'ANDES’s own documentation of the model, as plain text.'}
      </DialogDescription>
    </DialogHeader>
  );
}

/** Opened for one model, from a form: no list, the documentation of the model. */
function DirectBody({ model }: { model: string }) {
  return (
    <>
      <Header model={model} />
      <DocBody model={model} />
    </>
  );
}

/** Opened from the palette: the searchable list of every model, and the chosen one's text. */
function BrowseBody() {
  const list = useSupportedModels();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  const groups: Record<string, string[]> = list.data?.groups ?? {};
  const needle = query.trim().toLowerCase();
  // A group whose models all filter out is not rendered.
  const shown = Object.entries(groups)
    .map(
      ([group, models]) =>
        [
          group,
          needle === '' ? models : models.filter((m) => m.toLowerCase().includes(needle)),
        ] as const,
    )
    .filter(([, models]) => models.length > 0);
  // With nothing picked, the first model the list shows is the one shown.
  const effective = selected ?? shown[0]?.[1][0] ?? null;

  return (
    <>
      <Header model={null} />
      <div className="flex h-[60vh] min-h-0 gap-4">
        <div data-testid="model-doc-list" className="flex min-h-0 w-64 shrink-0 flex-col gap-2">
          <Input
            value={query}
            onChange={setQuery}
            placeholder="Search models…"
            aria-label="Search models"
          />
          <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
            {list.isPending ? (
              <p className="text-muted-foreground text-xs">Loading models…</p>
            ) : list.isError ? (
              <p
                role="alert"
                data-testid="model-doc-list-error"
                className="text-muted-foreground text-xs"
              >
                {isOtherEngine(list.error)
                  ? OTHER_ENGINE
                  : `The model list could not be loaded.${busyNote(list.error)}`}
              </p>
            ) : shown.length === 0 ? (
              <p className="text-muted-foreground text-xs">No model matches.</p>
            ) : (
              shown.map(([group, models]) => (
                <div key={group}>
                  <h3 className="text-muted-foreground text-xs font-semibold">{group}</h3>
                  {models.map((m) => (
                    <button
                      key={m}
                      type="button"
                      data-testid={`model-doc-item-${m}`}
                      aria-pressed={m === effective}
                      onClick={() => setSelected(m)}
                      className={cn(
                        'text-foreground hover:bg-muted w-full rounded-[var(--radius-sm)] px-2 py-0.5 text-left font-mono text-xs',
                        m === effective && 'bg-muted font-semibold',
                      )}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
        <DocBody model={effective} className="flex-1" />
      </div>
    </>
  );
}

/**
 * The documentation of ``model``, or which of the plain states stands in for
 * it. With no model (browse mode before the list has one) it is empty.
 */
function DocBody({ model, className }: { model: string | null; className?: string }) {
  const doc = useModelDoc(model);
  let body: ReactNode;
  if (model === null) {
    body = null;
  } else if (doc.isPending) {
    body = <p className="text-muted-foreground text-xs">Loading documentation…</p>;
  } else if (doc.isError) {
    const notFound = doc.error instanceof ProblemDetailsError && doc.error.status === 404;
    body = notFound ? (
      <p role="alert" data-testid="model-doc-not-found" className="text-muted-foreground text-xs">
        ANDES has no model with this name.
      </p>
    ) : isOtherEngine(doc.error) ? (
      <p
        role="alert"
        data-testid="model-doc-other-engine"
        className="text-muted-foreground text-xs"
      >
        {OTHER_ENGINE}
      </p>
    ) : (
      <p role="alert" data-testid="model-doc-error" className="text-danger text-xs">
        The documentation could not be loaded.{busyNote(doc.error)}
      </p>
    );
  } else {
    body = (
      // Focusable, so the keyboard scrolls the text, which is often longer
      // and wider than the block.
      <pre
        data-testid="model-doc-text"
        role="region"
        aria-label={`Documentation of ${model}`}
        tabIndex={0}
        className="bg-muted/40 text-foreground max-h-[60vh] min-h-0 overflow-auto rounded-[var(--radius-sm)] p-3 font-mono text-[11px] whitespace-pre"
      >
        {doc.data.doc}
      </pre>
    );
  }
  return (
    <div data-testid="model-doc-body" className={cn('flex min-h-0 min-w-0 flex-col', className)}>
      {body}
    </div>
  );
}
