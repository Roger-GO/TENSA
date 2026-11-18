import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ProblemDetailsError } from '@/api/client';
import { useAddExample } from '@/api/queries';
import type { ExampleListEntry } from '@/api/types';
import { Button } from '@/components/ui/button';
import {
  ANALYSIS_LABELS,
  CITATION_ROLES,
  citationRolesOf,
  citationsText,
  companionFileNames,
  detailsLabel,
  differsFromShipped,
  differsNote,
  hostOf,
  isLinkOnly,
  isWebUrl,
  primaryFileName,
  sizeText,
} from '@/lib/exampleCases';
import { cn } from '@/lib/cn';
import { describeError } from '@/lib/describeError';
import { toast } from '@/lib/toast';

/**
 * One example case of the dialog: what it is, how big, what can be run on it, where it
 * comes from, and what can be done with it. A case with a file is added to the
 * workspace and then opened; the card says so in its own words once the file is there
 * ("Added", or "Open now" while it is the open case). A case that is only links has a
 * link to its source page instead. "Cite" opens the references of the case, with a
 * button that copies them as text and one that copies them as BibTeX.
 *
 * A bundled case whose file in the workspace is not the one this TENSA ships (a workspace
 * made by an earlier release holds the file that release put under the name, or the file
 * was edited) does not say Added: it says the file is different, why, and offers to
 * replace it. Replacing overwrites the file, so it asks first, with the keyboard focus on
 * the button that keeps it. When the file is the open case, the session still holds the
 * old copy, and the card says so and offers to reload the case.
 *
 * Whatever a button cannot do is said in words under it, not left to a tooltip: the
 * installed ANDES does not hold the file, there is no session to open the case in, or
 * another case is loading. What an add answers (done, already there, refused, a warning
 * about the file) is said in the card and, for a success, in a notice.
 */
export interface ExampleCardProps {
  example: ExampleListEntry;
  /** The file of the case that is open now, or `null`. */
  openPath: string | null;
  /** Why no case can be opened now (no session yet, another case loading), or `null`. */
  openBlocked: string | null;
  /** Open the case, which is in the workspace. */
  onOpen: (example: ExampleListEntry) => void;
  /** Load the open case again, from its file. */
  onReload: () => void;
}

/** What the last add of this card answered, shown under its buttons. */
interface Note {
  kind: 'status' | 'warning' | 'error';
  text: string;
}

/**
 * What the last press of a Copy button did, said beside the buttons until the next press. A
 * copy the browser refused carries the text that was to be copied, which the panel then shows
 * to select, in whichever form (plain or BibTeX) was asked for.
 */
interface CopyResult {
  ok: boolean;
  text: string;
  byHand?: { what: string; text: string };
}

/** An address that opens in a new tab, the way the Help menu's links do. */
function ExternalLink({
  href,
  children,
  testId,
}: {
  href: string;
  children: ReactNode;
  testId?: string;
}) {
  // The catalog allows only http and https addresses; one that is not is shown, not followed.
  if (!isWebUrl(href)) return <span data-testid={testId}>{children}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-testid={testId}
      className={cn(
        'text-primary inline-flex items-center gap-1 underline underline-offset-2',
        'rounded-[var(--radius-sm)] hover:no-underline',
        'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
      )}
    >
      {children}
      <ExternalGlyph />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

export function ExampleCard({
  example,
  openPath,
  openBlocked,
  onOpen,
  onReload,
}: ExampleCardProps) {
  const ids = useId();
  const titleId = `${ids}-title`;
  const citeId = `${ids}-cite`;
  const add = useAddExample();
  const [citeOpen, setCiteOpen] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const [copyResult, setCopyResult] = useState<CopyResult | null>(null);
  // This card put the case in the workspace (or found it there) since the dialog opened. The
  // list says so a moment later, when it has been read again, and until then the card must
  // not offer Add a second time. The keyboard focus was on the Add button, which the Open
  // button replaces: it goes to Open, and not to the top of the dialog.
  const [addedNow, setAddedNow] = useState(false);
  // This card put the shipped file over the one in the workspace since the dialog opened: the
  // list says so a moment later, and until then the card must not offer Replace again.
  const [replacedNow, setReplacedNow] = useState(false);
  // The press of Replace with this version asked, and has not been answered.
  const [confirming, setConfirming] = useState(false);
  // The file that was replaced is the open case, which still holds the old copy.
  const [staleOpen, setStaleOpen] = useState(false);
  const openButton = useRef<HTMLButtonElement>(null);
  const replaceButton = useRef<HTMLButtonElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const reloadButton = useRef<HTMLButtonElement>(null);
  const noteBox = useRef<HTMLParagraphElement>(null);
  const byHandBox = useRef<HTMLTextAreaElement>(null);
  const cardBox = useRef<HTMLElement>(null);

  const linkOnly = isLinkOnly(example);
  const primary = primaryFileName(example);
  const differs = differsFromShipped(example) && !replacedNow;
  const added = example.in_workspace || addedNow || replacedNow;
  const openNow = primary !== null && openPath === primary;
  const citations = example.citations ?? [];
  const analyses = example.analyses ?? [];
  const size = sizeText(example);
  const prov = example.provenance;
  const caveats = example.caveats ?? [];
  const modifications = example.modifications ?? [];
  const details = detailsLabel(example);
  // The disclosure names its sections, so a heading inside it says nothing new when it holds one.
  const headed =
    [caveats.length > 0, modifications.length > 0, example.verification != null].filter(Boolean)
      .length > 1;
  const citationRoles = citationRolesOf(example);

  useEffect(() => {
    if (!addedNow) return;
    // Open takes the focus the Add button had. When Open is greyed out (no session yet, another
    // case loading) or is "Open now", the card does, so the keyboard does not fall to the page.
    const open = openButton.current;
    if (open !== null && !open.disabled) open.focus();
    else cardBox.current?.focus();
  }, [addedNow]);
  // The Replace button is gone once the file is replaced: the keyboard focus goes to what the
  // card offers next (the reload of the case that holds the old file, else Open).
  useEffect(() => {
    if (replacedNow) (reloadButton.current ?? openButton.current)?.focus();
  }, [replacedNow]);
  // Asking moves the focus to the button that keeps the file; an answer of "keep" gives it back
  // to the button that asked.
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (confirming) keepButton.current?.focus();
    else if (wasConfirming.current) replaceButton.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);
  // The text of a refused copy is selected, so the user's next key is the copy.
  useEffect(() => {
    if (copyResult?.byHand !== undefined) {
      byHandBox.current?.focus();
      byHandBox.current?.select();
    }
  }, [copyResult]);
  // A note is under the buttons, which may be below the fold of a long list.
  useEffect(() => {
    if (note !== null) noteBox.current?.scrollIntoView?.({ block: 'nearest' });
  }, [note]);

  const onAdd = () => {
    setNote(null);
    // ``mutateAsync`` and not callbacks on ``mutate``: those only run while the card is
    // mounted, and the notice of an add that ends after the dialog was closed is the
    // one a user looks for.
    void add.mutateAsync({ id: example.id }).then(
      (done) => {
        const warnings = done.warnings;
        if (warnings.length > 0) {
          setNote({ kind: 'warning', text: `Added ${done.primary}. ${warnings.join(' ')}` });
          setAddedNow(true);
          toast.warning(`Added ${done.primary} to the workspace`, {
            id: `example-added-${example.id}`,
            description: warnings.join(' '),
          });
        } else {
          // The card says the rest: Added, and an Open button.
          setAddedNow(true);
          toast.success(`Added ${done.primary} to the workspace`, {
            id: `example-added-${example.id}`,
            description: `Its source, citations and licence are in ${done.sources_file} beside it.`,
          });
        }
      },
      (err: unknown) => {
        // The file is there already (a stale list, or another tab): the list is read
        // again, and the card is about to say Added.
        if (err instanceof ProblemDetailsError && err.status === 409) {
          setNote({
            kind: 'status',
            text: `${primary ?? 'The file'} is already in the workspace.`,
          });
          setAddedNow(true);
          return;
        }
        // The card says it, and a notice too: the dialog may be closed by now, and the card
        // with it, when the answer comes.
        const reason = describeError(err);
        setNote({ kind: 'error', text: `Could not add this case: ${reason}` });
        toast.error(`Could not add ${example.title}`, {
          id: `example-added-${example.id}`,
          description: reason,
        });
      },
    );
  };

  const onReplace = () => {
    setConfirming(false);
    setNote(null);
    // The case is open now (the card says "Open now"): the session loaded its old file.
    const wasOpen = openNow;
    void add.mutateAsync({ id: example.id, overwrite: true }).then(
      (done) => {
        setReplacedNow(true);
        setStaleOpen(wasOpen);
        const warnings = done.warnings;
        const text = wasOpen
          ? `Replaced ${done.primary}. The open case still holds the old file: reload it to get this one.`
          : `Replaced ${done.primary}.`;
        setNote({
          kind: wasOpen || warnings.length > 0 ? 'warning' : 'status',
          text: [text, ...warnings].join(' '),
        });
        toast.success(`Replaced ${done.primary} in the workspace`, {
          id: `example-added-${example.id}`,
          description: `Its source, citations and licence in ${done.sources_file} are the ones of this version.`,
        });
      },
      (err: unknown) => {
        const reason = describeError(err);
        setNote({ kind: 'error', text: `Could not replace this file: ${reason}` });
        toast.error(`Could not replace ${primary ?? 'the file'}`, {
          id: `example-added-${example.id}`,
          description: reason,
        });
      },
    );
  };

  // The answer is said beside the buttons as well as in a notice: the notice is drawn at the
  // corner of the window and is gone in a few seconds, and a press that seems to have done
  // nothing is the one a user presses again.
  const copy = async (format: 'text' | 'bibtex') => {
    const what = format === 'bibtex' ? 'BibTeX' : 'citation';
    setCopyResult(null);
    try {
      await navigator.clipboard.writeText(citationsText(example, format));
      setCopyResult({
        ok: true,
        text: format === 'bibtex' ? 'Copied as BibTeX.' : 'Copied as text.',
      });
      toast.success(`Copied the ${what} of ${example.title}`, { id: 'example-cite-copied' });
    } catch {
      setCopyResult({
        ok: false,
        text: `The browser did not let the ${what} be copied. It is selected below: copy it by hand.`,
        byHand: { what, text: citationsText(example, format) },
      });
      toast.error(`The browser did not let the ${what} be copied`, {
        id: 'example-cite-copied',
        description: 'The text is selected in the Cite panel: copy it by hand.',
      });
    }
  };

  // Why Add is greyed out, in words.
  const addBlocked =
    !linkOnly && !added && !example.available
      ? prov.kind === 'andes'
        ? 'The installed ANDES does not have this case.'
        : 'This installation of TENSA is missing the file of this case.'
      : null;

  return (
    <article
      ref={cardBox}
      tabIndex={-1}
      aria-labelledby={titleId}
      data-testid={`example-card-${example.id}`}
      data-added={added ? 'true' : undefined}
      data-differs={differs ? 'true' : undefined}
      className="border-border bg-background flex flex-col gap-2 rounded-[var(--radius-md)] border p-3 outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
    >
      <h4 id={titleId} className="text-foreground text-sm leading-snug font-semibold">
        {example.title}
      </h4>

      <ul
        aria-label="Size and analyses"
        className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-[11px]"
      >
        {size !== null ? (
          <li data-testid={`example-size-${example.id}`} className="font-mono">
            {size}
          </li>
        ) : null}
        {linkOnly ? (
          <li className="border-border rounded-[var(--radius-sm)] border px-1.5 py-px">
            Link only
          </li>
        ) : null}
        {analyses.map((analysis) => (
          <li
            key={analysis}
            data-testid={`example-analysis-${example.id}-${analysis}`}
            className="border-border bg-muted/40 text-foreground rounded-[var(--radius-sm)] border px-1.5 py-px"
          >
            {ANALYSIS_LABELS[analysis]}
          </li>
        ))}
      </ul>

      <p className="text-foreground text-[13px] leading-relaxed">{example.summary}</p>

      <p className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
        {primary !== null ? (
          <span>
            File:{' '}
            <span data-testid={`example-file-${example.id}`} className="text-foreground font-mono">
              {[primary, ...companionFileNames(example)].join(', ')}
            </span>
          </span>
        ) : null}
        {!linkOnly && prov.source_url !== null && prov.source_url !== undefined ? (
          <span>
            Source:{' '}
            <ExternalLink href={prov.source_url} testId={`example-source-${example.id}`}>
              {prov.built ? 'built by TENSA (script)' : (prov.release ?? hostOf(prov.source_url))}
            </ExternalLink>
          </span>
        ) : null}
        <span>
          Licence:{' '}
          {example.licence.url !== null && example.licence.url !== undefined ? (
            <ExternalLink href={example.licence.url} testId={`example-licence-${example.id}`}>
              {example.licence.name}
            </ExternalLink>
          ) : (
            <span data-testid={`example-licence-${example.id}`} className="text-foreground">
              {example.licence.name}
            </span>
          )}
        </span>
      </p>

      {linkOnly ? (
        <ul className="flex flex-col gap-1 text-xs" aria-label="Where to get the data">
          {(example.links ?? []).map((link, index, all) => (
            <li key={`${index}-${link.url}`} className="flex flex-col gap-0.5">
              <span>
                <ExternalLink href={link.url} testId={`example-link-${example.id}-${index}`}>
                  {all.length === 1 ? 'Open source page' : link.title}
                  {all.length === 1 ? <span className="sr-only"> for {link.title}</span> : null}
                </ExternalLink>
              </span>
              {link.note !== null && link.note !== undefined ? (
                <span className="text-muted-foreground">{link.note}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {details !== null ? (
        <details data-testid={`example-details-${example.id}`} className="text-xs">
          <summary
            className={cn(
              'text-primary w-fit cursor-pointer rounded-[var(--radius-sm)]',
              'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
            )}
          >
            {details}
          </summary>
          <div className="text-muted-foreground mt-1.5 flex flex-col gap-2">
            {caveats.length > 0 ? (
              <div>
                {headed ? <p className="text-foreground font-medium">Caveats</p> : null}
                <ul className="list-disc pl-4">
                  {caveats.map((c, index) => (
                    <li key={`${index}-${c}`}>{c}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {modifications.length > 0 ? (
              <div>
                {headed ? (
                  <p className="text-foreground font-medium">Changes made to the data</p>
                ) : null}
                <ul className="list-disc pl-4">
                  {modifications.map((m, index) => (
                    <li key={`${index}-${m}`}>{m}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {example.verification ? (
              <div>
                {headed ? (
                  <p className="text-foreground font-medium">
                    {linkOnly ? 'What was tried with TENSA' : 'How it was checked'}
                  </p>
                ) : null}
                <p>{example.verification.summary}</p>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}

      <div className="mt-1 flex flex-wrap items-center gap-2">
        {linkOnly ? null : differs ? (
          <>
            <span
              data-testid={`example-differs-${example.id}`}
              title={
                primary !== null ? `${primary} in the workspace is not the shipped file` : undefined
              }
              className={cn(
                'border-warning/50 bg-warning/20 text-foreground inline-flex items-center gap-1',
                'rounded-[var(--radius-sm)] border px-2 py-1 text-[11px] font-medium',
              )}
            >
              <WarningGlyph />
              Different file
            </span>
            {confirming ? null : (
              <Button
                type="button"
                ref={replaceButton}
                variant="primary"
                size="sm"
                disabled={add.isPending}
                aria-busy={add.isPending ? 'true' : undefined}
                onClick={() => setConfirming(true)}
                aria-label={`${add.isPending ? 'Replacing…' : 'Replace with this version'}: ${example.title}`}
                data-testid={`example-replace-${example.id}`}
              >
                {add.isPending ? 'Replacing…' : 'Replace with this version'}
              </Button>
            )}
            {openNow ? (
              <span
                data-testid={`example-open-now-${example.id}`}
                className="text-muted-foreground text-xs"
              >
                Open now
              </span>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={openBlocked !== null}
                onClick={() => onOpen(example)}
                aria-label={`Open: ${example.title}`}
                data-testid={`example-open-${example.id}`}
              >
                Open
              </Button>
            )}
          </>
        ) : added ? (
          <>
            <span
              data-testid={`example-added-${example.id}`}
              title={primary !== null ? `In the workspace as ${primary}` : undefined}
              className={cn(
                'border-success/40 bg-success/15 text-foreground inline-flex items-center gap-1',
                'rounded-[var(--radius-sm)] border px-2 py-1 text-[11px] font-medium',
              )}
            >
              <CheckGlyph />
              Added
            </span>
            {openNow ? (
              <span
                data-testid={`example-open-now-${example.id}`}
                className="text-muted-foreground text-xs"
              >
                Open now
              </span>
            ) : (
              <Button
                type="button"
                ref={openButton}
                variant="primary"
                size="sm"
                disabled={openBlocked !== null}
                onClick={() => onOpen(example)}
                aria-label={`Open: ${example.title}`}
                data-testid={`example-open-${example.id}`}
              >
                Open
              </Button>
            )}
          </>
        ) : (
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={add.isPending || addBlocked !== null}
            aria-busy={add.isPending ? 'true' : undefined}
            onClick={onAdd}
            aria-label={`${add.isPending ? 'Adding…' : 'Add to workspace'}: ${example.title}`}
            data-testid={`example-add-${example.id}`}
          >
            {add.isPending ? 'Adding…' : 'Add to workspace'}
          </Button>
        )}
        {citations.length > 0 ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-expanded={citeOpen}
            aria-controls={citeId}
            onClick={() => {
              setCiteOpen((open) => !open);
              setCopyResult(null);
            }}
            aria-label={`Cite: ${example.title}`}
            data-testid={`example-cite-${example.id}`}
            className="aria-expanded:bg-muted"
          >
            Cite
          </Button>
        ) : null}
      </div>

      {differs ? (
        <p
          data-testid={`example-differs-note-${example.id}`}
          className="text-muted-foreground text-[11px] leading-snug"
        >
          {differsNote(example)}
        </p>
      ) : null}
      {differs && confirming ? (
        <div
          role="group"
          aria-label={`Replace ${primary ?? 'the file'}?`}
          data-testid={`example-replace-confirm-${example.id}`}
          className="border-warning/50 bg-warning/20 flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] border px-2 py-1.5 text-[11px] leading-snug"
        >
          <span className="text-foreground min-w-0 flex-1">
            Replace {primary ?? 'the file'} in your workspace? Your file is overwritten and cannot
            be brought back.
          </span>
          <Button
            type="button"
            ref={keepButton}
            variant="outline"
            size="sm"
            onClick={() => setConfirming(false)}
            data-testid={`example-replace-keep-${example.id}`}
          >
            Keep my file
          </Button>
          <Button
            type="button"
            variant="danger"
            size="sm"
            onClick={onReplace}
            data-testid={`example-replace-confirm-yes-${example.id}`}
          >
            Replace
          </Button>
        </div>
      ) : null}
      {staleOpen && openNow ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            ref={reloadButton}
            variant="primary"
            size="sm"
            disabled={openBlocked !== null}
            onClick={() => {
              setStaleOpen(false);
              onReload();
            }}
            aria-label={`Reload the open case: ${example.title}`}
            data-testid={`example-reload-${example.id}`}
          >
            Reload case
          </Button>
          {openBlocked !== null ? (
            <span className="text-muted-foreground text-[11px]">{openBlocked}</span>
          ) : null}
        </div>
      ) : null}
      {added && !openNow && openBlocked !== null ? (
        <p
          data-testid={`example-open-blocked-${example.id}`}
          className="text-muted-foreground text-[11px]"
        >
          {openBlocked}
        </p>
      ) : null}
      {addBlocked !== null ? (
        <p
          data-testid={`example-add-blocked-${example.id}`}
          className="text-muted-foreground text-[11px]"
        >
          {addBlocked}
        </p>
      ) : null}
      {note !== null ? (
        <p
          ref={noteBox}
          role={note.kind === 'error' ? 'alert' : 'status'}
          data-testid={`example-note-${example.id}`}
          data-kind={note.kind}
          className={cn(
            'rounded-[var(--radius-sm)] border px-2 py-1 text-[11px] leading-snug',
            note.kind === 'error' && 'border-danger/40 bg-danger/5 text-foreground',
            note.kind === 'warning' && 'border-warning/50 bg-warning/20 text-foreground',
            note.kind === 'status' && 'border-border bg-muted/30 text-foreground',
          )}
        >
          {note.text}
        </p>
      ) : null}

      <div
        id={citeId}
        hidden={!citeOpen}
        data-testid={`example-cite-panel-${example.id}`}
        className="border-border bg-muted/30 flex flex-col gap-2 rounded-[var(--radius-sm)] border p-2.5"
      >
        {citeOpen ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void copy('text')}
                aria-label={`Copy as text: ${example.title}`}
                data-testid={`example-copy-text-${example.id}`}
              >
                Copy as text
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void copy('bibtex')}
                aria-label={`Copy as BibTeX: ${example.title}`}
                data-testid={`example-copy-bibtex-${example.id}`}
              >
                Copy as BibTeX
              </Button>
              {/* Always in the page, so a screen reader hears what is put into it. */}
              <span
                role="status"
                data-testid={`example-copy-status-${example.id}`}
                className={cn(
                  'inline-flex items-center gap-1 text-xs',
                  copyResult?.ok === false ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                {copyResult?.ok === true ? <CheckGlyph /> : null}
                {copyResult?.text}
              </span>
            </div>
            {copyResult?.byHand !== undefined ? (
              <textarea
                ref={byHandBox}
                readOnly
                rows={Math.min(8, copyResult.byHand.text.split('\n').length)}
                value={copyResult.byHand.text}
                aria-label={`The ${copyResult.byHand.what} to copy by hand: ${example.title}`}
                data-testid={`example-copy-by-hand-${example.id}`}
                className="border-border bg-background text-foreground w-full resize-y rounded-[var(--radius-sm)] border p-1.5 font-mono text-[11px] leading-snug"
              />
            ) : null}
            <p
              data-testid={`example-cite-legend-${example.id}`}
              className="text-muted-foreground text-[11px] leading-snug"
            >
              Each reference says what it is:{' '}
              {citationRoles
                .map((role) => `${CITATION_ROLES[role].label}, ${CITATION_ROLES[role].what}`)
                .join('; ')}
              .
            </p>
            <ol className="text-foreground flex list-decimal flex-col gap-1.5 pl-4 text-xs">
              {citations.map((c, index) => (
                <li key={`${index}-${c.text}`} className="break-words">
                  <span
                    data-testid={`example-cite-role-${example.id}-${index}`}
                    className="border-border bg-background text-foreground mr-1.5 inline-block rounded-[var(--radius-sm)] border px-1.5 py-px align-baseline text-[10px] font-medium"
                  >
                    {CITATION_ROLES[c.role].label}
                  </span>
                  {c.text}
                  {c.url !== null && c.url !== undefined ? (
                    <>
                      {' '}
                      <ExternalLink href={c.url}>{hostOf(c.url)}</ExternalLink>
                    </>
                  ) : null}
                </li>
              ))}
            </ol>
            {example.licence.attribution !== null && example.licence.attribution !== undefined ? (
              <p className="text-muted-foreground text-[11px]">
                Licence ({example.licence.name}): {example.licence.attribution}
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </article>
  );
}

function CheckGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3 w-3 shrink-0"
    >
      <path d="m5 12 5 5L20 7" />
    </svg>
  );
}

function WarningGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3 w-3 shrink-0"
    >
      <path d="M12 4 2.5 20h19L12 4Z" />
      <path d="M12 10v5M12 18h.01" />
    </svg>
  );
}

function ExternalGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 12 12"
      width="10"
      height="10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <path d="M5 2.5H3a.5.5 0 0 0-.5.5v6a.5.5 0 0 0 .5.5h6a.5.5 0 0 0 .5-.5V7" />
      <path d="M7 2.5h2.5V5M9.5 2.5 5.5 6.5" />
    </svg>
  );
}
