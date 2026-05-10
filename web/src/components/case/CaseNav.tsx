import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { WorkspaceFilePicker } from './WorkspaceFilePicker';
import { ChangeCaseConfirmDialog } from './ChangeCaseConfirmDialog';
import { useCaseStore } from '@/store/case';
import { useSessionStore } from '@/store/session';
import { usePflowStore } from '@/store/pflow';
import { useDeleteSession } from '@/api/queries';
import { cn } from '@/lib/cn';
import type { CaseSelection } from '@/store/case';
import type { TopologySummary } from '@/api/types';

/**
 * CaseNav. Left-rail container for case management. Two states:
 *
 * - **No case loaded** (`case.selection === null`): renders the
 *   `WorkspaceFilePicker`. The picker creates a session lazily and
 *   wires the case-load mutation.
 * - **Case loaded** (`case.selection !== null`): renders a summary card
 *   with the case name, addfiles, topology state badge, and a "Change
 *   case" button. Clicking the button opens
 *   `ChangeCaseConfirmDialog` (R18: this is the appropriate use of a
 *   modal — destructive confirmation).
 *
 * "Change case" is disabled while `pflow.isRunning === true` (avoids
 * tearing down a session mid-RPC). A tooltip explains the disabled
 * cause.
 */

/** Pull the basename out of a workspace-relative path. */
function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

interface SummaryCardProps {
  selection: CaseSelection;
  topology: TopologySummary | null;
  pflowRunning: boolean;
  onChangeCase: () => void;
}

function SummaryCard({ selection, topology, pflowRunning, onChangeCase }: SummaryCardProps) {
  const stateLabel = topology?.state ?? 'pre-setup';
  const stateBadgeClass =
    stateLabel === 'committed'
      ? 'bg-success/15 text-foreground border-success/30'
      : 'bg-muted text-muted-foreground border-border';

  // Compact ghost button — the loaded-case card is information-dense; a
  // full-width primary-style button overweights the secondary action.
  const changeCaseButton = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={pflowRunning}
      onClick={onChangeCase}
      aria-describedby={pflowRunning ? 'change-case-disabled-reason' : undefined}
      className="text-muted-foreground hover:text-foreground -ml-2 self-start text-xs"
    >
      {selection.blank ? 'Discard system' : 'Change case'}
    </Button>
  );

  const isBlank = selection.blank === true;
  return (
    <div className={cn('flex flex-col gap-3 p-3')}>
      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground text-xs font-medium">
          {isBlank ? 'New system' : 'Loaded case'}
        </p>
        <p className="text-foreground truncate font-mono text-sm">
          {isBlank
            ? '— blank —'
            : selection.primaryPath
              ? basename(selection.primaryPath)
              : ''}
        </p>
        {selection.addfiles.length > 0 ? (
          <div className="flex flex-col gap-0.5">
            <p className="text-muted-foreground text-xs">Addfiles</p>
            <ul className="text-foreground flex flex-col gap-0.5 font-mono text-xs">
              {selection.addfiles.map((p) => (
                <li key={p} className="truncate">
                  {basename(p)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-[var(--radius-sm)] border px-2 py-0.5',
            'font-mono text-xs',
            stateBadgeClass,
          )}
        >
          {stateLabel}
        </span>
      </div>

      {pflowRunning ? (
        <TooltipProvider delayDuration={150}>
          <Tooltip>
            <TooltipTrigger asChild>
              {/* Wrap the disabled button in a span so hover/focus still
                  reaches the trigger — disabled buttons don't fire pointer
                  events, but the wrapping span does. */}
              <span tabIndex={0} className="block">
                {changeCaseButton}
              </span>
            </TooltipTrigger>
            <TooltipPortal>
              <TooltipContent id="change-case-disabled-reason">
                Wait for power flow to finish.
              </TooltipContent>
            </TooltipPortal>
          </Tooltip>
        </TooltipProvider>
      ) : (
        changeCaseButton
      )}
    </div>
  );
}

export interface CaseNavProps {
  className?: string;
}

export function CaseNav({ className }: CaseNavProps) {
  const selection = useCaseStore((s) => s.selection);
  const topology = useCaseStore((s) => s.topology);
  const clearCase = useCaseStore((s) => s.clearCase);
  const sessionId = useSessionStore((s) => s.sessionId);
  const pflowRunning = usePflowStore((s) => s.isRunning);
  const clearPflow = usePflowStore((s) => s.clearPflow);

  const deleteSession = useDeleteSession();

  const [confirmOpen, setConfirmOpen] = useState<boolean>(false);

  const isConfirming = deleteSession.isPending;

  // v0.2 polish Unit 1 — session re-creation after DELETE is owned by the
  // App-level ``useSessionRecovery`` driver (single source of truth for
  // ``useCreateSession``). CaseNav previously called ``createSession.mutate``
  // here too, racing the picker's own ``useEnsureSession`` instance — both
  // would fire ``POST /sessions`` and only one ``setSessionId`` won. The
  // picker would then render against the loser and the next Load click
  // would 404. Now CaseNav just clears state + deletes the session; the
  // App-level driver notices ``sessionId === null`` and mints a fresh one.
  const onConfirmChangeCase = () => {
    const proceed = () => {
      // Clear the case + pflow slices regardless of DELETE outcome — the
      // user has chosen to discard, and the session_id may already be
      // dead (404). The store cascade in store/index.ts also fires off
      // the session clear when sessionId transitions to null.
      clearCase();
      clearPflow();
      // Close the dialog. The App-level useSessionRecovery driver will
      // notice ``sessionId === null`` and fire a fresh ``POST /sessions``
      // automatically.
      setConfirmOpen(false);
    };

    if (sessionId) {
      deleteSession.mutate(sessionId, {
        onSuccess: () => {
          proceed();
        },
        onError: () => {
          // Session was probably already gone (404). Continue anyway —
          // the user wanted to discard.
          proceed();
        },
      });
    } else {
      proceed();
    }
  };

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      {selection === null ? (
        <WorkspaceFilePicker />
      ) : (
        <SummaryCard
          selection={selection}
          topology={topology}
          pflowRunning={pflowRunning}
          onChangeCase={() => setConfirmOpen(true)}
        />
      )}

      <ChangeCaseConfirmDialog
        open={confirmOpen}
        onCancel={() => {
          if (!isConfirming) setConfirmOpen(false);
        }}
        onConfirm={onConfirmChangeCase}
        isConfirming={isConfirming}
      />
    </div>
  );
}
