import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { useCurrentTopology, usePutSidecar, useSaveCase } from '@/api/queries';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { ProblemDetailsError } from '@/api/client';
import { parseWorkspacePath, type SidecarLayout } from '@/api/types';
import { SIDECAR_SCHEMA_VERSION } from '@/components/sld/sidecar';
import { cn } from '@/lib/cn';

/**
 * "Save system" button + format-picker modal.
 *
 * Visible whenever a topology is loaded. Clicking opens a modal with:
 *
 * - Filename input (workspace-relative; extension auto-derived from
 *   format).
 * - Format radio: xlsx (ANDES native) or json. PSS/E .raw write is NOT
 *   supported by ANDES 2.0 — the modal explains the constraint.
 * - Submit fires `useSaveCase()`. On 409 (file exists) the modal flips
 *   to an "Overwrite?" confirmation.
 */
export interface SaveSystemButtonProps {
  className?: string;
}

type Format = 'xlsx' | 'json' | 'raw';

const EXT_BY_FORMAT: Record<Format, string> = {
  xlsx: '.xlsx',
  json: '.json',
  raw: '.raw',
};

function ensureExtension(filename: string, format: Format): string {
  const ext = EXT_BY_FORMAT[format];
  if (filename.endsWith(ext)) return filename;
  // Strip any other recognized extension before appending.
  const stripped = filename.replace(/\.(xlsx|json|raw|dyr|m)$/i, '');
  return stripped + ext;
}

export function SaveSystemButton({ className }: SaveSystemButtonProps) {
  const sessionId = useSessionStore((s) => s.sessionId);
  const topology = useCurrentTopology();
  const dragOverrides = useCaseStore((s) => s.dragOverrides);
  const saveMutation = useSaveCase();
  const sidecarMutation = usePutSidecar();
  const [modalOpen, setModalOpen] = useState(false);
  const [filename, setFilename] = useState('my-system');
  const [format, setFormat] = useState<Format>('xlsx');
  const [overwrite, setOverwrite] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const enabled = sessionId !== null && topology !== null;

  const writeSidecarAlongside = (caseFilename: string) => {
    // Build a sidecar carrying the current bus coords from drag
    // overrides. Non-bus nodes are skipped (the substrate sidecar
    // schema doesn't carry non_bus_coordinates yet — deferred to a
    // later pass).
    const coordinates: Record<string, { x: number; y: number }> = {};
    for (const [nodeId, coord] of Object.entries(dragOverrides)) {
      // Bus nodes use the bus idx as React Flow node id (no kind
      // prefix); non-bus nodes are `${kind}-${idx}`. Filter to buses.
      if (
        nodeId.startsWith('generator-') ||
        nodeId.startsWith('load-') ||
        nodeId.startsWith('shunt-')
      ) {
        continue;
      }
      coordinates[nodeId] = coord;
    }
    if (Object.keys(coordinates).length === 0) {
      // Nothing to persist — buses fell back to defaults / curated /
      // auto-layout coords. Skip silently.
      return;
    }
    const sidecar: SidecarLayout = {
      schema_version: SIDECAR_SCHEMA_VERSION,
      andes_version: 'unknown',
      coordinates,
      last_modified: new Date().toISOString(),
    };
    try {
      sidecarMutation.mutate({
        casePath: parseWorkspacePath(caseFilename),
        layout: sidecar,
      });
    } catch {
      // Workspace-path parse error — only happens if filename has
      // traversal segments, which the substrate already rejected.
      // Silent because the case file itself wrote successfully.
    }
  };

  const submit = () => {
    if (!sessionId) return;
    setError(null);
    setSuccess(null);
    const targetName = ensureExtension(filename.trim(), format);
    if (targetName === ensureExtension('', format) || targetName.length <= 5) {
      setError('Pick a non-empty filename.');
      return;
    }
    saveMutation.mutate(
      {
        sessionId,
        body: { filename: targetName, format, overwrite },
      },
      {
        onSuccess: (resp) => {
          // Auto-save the layout sidecar alongside the case file so
          // reload preserves the user's drag positions (Unit 13a).
          writeSidecarAlongside(resp.filename);
          setSuccess(`Wrote ${resp.bytes_written} bytes to ${resp.filename}`);
          setTimeout(() => setModalOpen(false), 1200);
        },
        onError: (err) => {
          if (err instanceof ProblemDetailsError) {
            if (err.status === 409 && !overwrite) {
              setError(
                'A file by that name already exists. Tick "Overwrite" to replace it.',
              );
              return;
            }
            setError(err.detail ?? err.title ?? 'Save failed');
          } else if (err instanceof Error) {
            setError(err.message);
          }
        },
      },
    );
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!enabled}
        onClick={() => {
          setModalOpen(true);
          setError(null);
          setSuccess(null);
        }}
        className={className}
        data-testid="save-system-button"
      >
        Save system
      </Button>
      <Dialog
        open={modalOpen}
        onOpenChange={(next) => {
          if (!next) setModalOpen(false);
        }}
      >
        <DialogContent>
          <DialogTitle>Save system</DialogTitle>
          <DialogDescription className="mt-2">
            Write the current topology to the workspace as a file you can
            re-load later. The current layout (drag positions) saves
            automatically alongside the case file as
            <code> &lt;filename&gt;.layout.json</code>.
          </DialogDescription>
          <div className="mt-4 flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground text-xs font-medium">
                Filename (without extension)
              </span>
              <input
                type="text"
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
                disabled={saveMutation.isPending}
                className="bg-background border-border h-8 rounded border px-2 font-mono text-sm"
                data-testid="save-filename"
              />
              <span className="text-muted-foreground text-[10px]">
                Will save as <code>{ensureExtension(filename || 'my-system', format)}</code>
              </span>
            </label>
            <fieldset className="flex flex-col gap-2">
              <legend className="text-muted-foreground text-xs font-medium">Format</legend>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="save-format"
                  checked={format === 'xlsx'}
                  onChange={() => setFormat('xlsx')}
                  disabled={saveMutation.isPending}
                />
                <span>
                  <strong>xlsx</strong> — ANDES native, opens in Excel
                </span>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="save-format"
                  checked={format === 'raw'}
                  onChange={() => setFormat('raw')}
                  disabled={saveMutation.isPending}
                />
                <span>
                  <strong>raw</strong> — PSS/E v33 (round-trips through ANDES's reader)
                </span>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="save-format"
                  checked={format === 'json'}
                  onChange={() => setFormat('json')}
                  disabled={saveMutation.isPending}
                />
                <span>
                  <strong>json</strong> — cleanest round-trip
                </span>
              </label>
            </fieldset>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={overwrite}
                onChange={(e) => setOverwrite(e.target.checked)}
                disabled={saveMutation.isPending}
              />
              <span>Overwrite if exists</span>
            </label>
            {error ? (
              <div
                role="alert"
                data-testid="save-error"
                className={cn(
                  'border-destructive/30 bg-destructive/10 text-foreground',
                  'rounded-[var(--radius-sm)] border px-2 py-1.5 text-xs',
                )}
              >
                {error}
              </div>
            ) : null}
            {success ? (
              <div
                role="status"
                className={cn(
                  'border-success/30 bg-success/10 text-foreground',
                  'rounded-[var(--radius-sm)] border px-2 py-1.5 text-xs',
                )}
              >
                {success}
              </div>
            ) : null}
          </div>
          <DialogFooter className="mt-4">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setModalOpen(false)}
              disabled={saveMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={submit}
              disabled={saveMutation.isPending}
              data-testid="save-confirm"
            >
              {saveMutation.isPending ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
