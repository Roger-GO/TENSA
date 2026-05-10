/**
 * EditMenu — TopBar dropdown housing in-session edit history actions.
 *
 * Unit 9 of the v2.0 polish plan refactored this file to derive its
 * items from the shared command registry. The Undo + Reload commands
 * (previously embedded as the `<WorkflowToolbar />` component inside
 * the popover) are now declared in `web/src/lib/commands.ts`; both the
 * menu and the ⌘K palette read the same registry.
 *
 * Reload-confirm dialog ownership: the reload command is destructive
 * (drops every local edit), so it routes through a confirmation
 * dialog rather than firing the mutation directly. The dialog's open
 * state lives in this component (`useState`), and the registry's
 * `edit.reload` action posts to the palette-dialog bridge so both
 * paths (menu click + palette pick) open the same dialog.
 *
 * The `<WorkflowToolbar />` component itself is no longer mounted
 * here — its tests (`tests/unit/components/case/WorkflowToolbar.test.tsx`)
 * keep covering the underlying mutation logic, but the topbar surface
 * for those actions is now the registry-driven menu items below.
 */
import { useEffect, useState } from 'react';
import { TopBarMenu, TopBarMenuItem } from './TopBarMenu';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { useReloadCase } from '@/api/queries';
import { useSessionStore } from '@/store/session';
import { useCommandRegistry, subscribePaletteDialog } from '@/lib/commands';
import { ProblemDetailsError } from '@/api/client';

const TESTID_BY_ID: Record<string, string> = {
  'edit.undo': 'topbar-menu-edit-undo',
  'edit.reload': 'topbar-menu-edit-reload',
};

export function EditMenu() {
  const commands = useCommandRegistry();
  const editCommands = commands.filter((c) => c.group === 'edit');

  const sessionId = useSessionStore((s) => s.sessionId);
  const reload = useReloadCase();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return subscribePaletteDialog((key) => {
      if (key === 'reload-confirm') setConfirmOpen(true);
    });
  }, []);

  // The registry's `edit.reload` action posts the bridge event; the
  // menu's onClick path hits the same registry action so both surfaces
  // converge on the same open path. The Undo command runs the
  // mutation directly (no confirm needed — it drops one item).
  const handleClick = (id: string) => {
    const cmd = editCommands.find((c) => c.id === id);
    cmd?.action();
  };

  const handleReload = () => {
    if (!sessionId) return;
    setError(null);
    reload.mutate(sessionId, {
      onSuccess: () => setConfirmOpen(false),
      onError: (err) => {
        if (err instanceof ProblemDetailsError) {
          setError(err.detail ?? err.title ?? 'Reload failed');
        } else if (err instanceof Error) {
          setError(err.message);
        }
      },
    });
  };

  return (
    <>
      <TopBarMenu label="Edit" testId="topbar-menu-edit">
        {editCommands.map((cmd) => (
          <TopBarMenuItem
            key={cmd.id}
            testId={TESTID_BY_ID[cmd.id] ?? `topbar-menu-edit-${cmd.id}`}
            onClick={() => handleClick(cmd.id)}
          >
            {cmd.label}
          </TopBarMenuItem>
        ))}
        {editCommands.length === 0 ? (
          <div className="text-muted-foreground px-2 py-1.5 text-xs">No edits available.</div>
        ) : null}
      </TopBarMenu>
      <Dialog
        open={confirmOpen}
        onOpenChange={(next) => {
          if (!next) setConfirmOpen(false);
        }}
      >
        <DialogContent>
          <DialogTitle>Reload from file?</DialogTitle>
          <DialogDescription className="mt-2">
            Reloading will re-parse the case from disk and discard every element you&apos;ve added
            or edited since loading. Any PF results will be cleared. This cannot be undone.
          </DialogDescription>
          {error ? (
            <p
              role="alert"
              className="text-danger mt-2 text-xs"
              data-testid="edit-menu-reload-error"
            >
              {error}
            </p>
          ) : null}
          <DialogFooter className="mt-4">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setConfirmOpen(false)}
              disabled={reload.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              size="sm"
              onClick={handleReload}
              disabled={reload.isPending}
              data-testid="reload-confirm"
            >
              {reload.isPending ? 'Reloading…' : 'Discard edits & reload'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
