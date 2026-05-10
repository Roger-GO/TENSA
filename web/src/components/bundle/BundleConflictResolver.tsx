/**
 * BundleConflictResolver (Unit 10 of the v2.0 plan).
 *
 * Renders the conflict list returned by the substrate's
 * ``POST /sessions/{id}/bundle/import`` validation pass when at least
 * one conflict is surfaced. Three conflict kinds are handled:
 *
 * - ``andes-version``: warning banner — the bundle was exported against
 *   a different ANDES major.minor. The import can still proceed
 *   (substrate's ``accept_version_mismatch`` defaults to True); the
 *   warning is informational.
 * - ``addfile-missing``: blocker banner — the manifest references an
 *   addfile that's not in the zip. The user can't resolve this from
 *   the UI; they must re-export the bundle. The "Re-export bundle"
 *   CTA copy mirrors the plan's edge-case requirement.
 * - ``sha-mismatch``: side-by-side metadata diff (filename / sha256 /
 *   size for both bundle-version and workspace-version). The user
 *   picks "use bundle" or "use workspace original" via radio
 *   buttons; the choice maps to the ``use_bundle_case`` flag the
 *   re-issued mutation passes to the substrate.
 *
 * The component is a pure render — it owns no state. The parent
 * dialog owns ``useBundleCase`` / ``acceptVersionMismatch`` and
 * forwards them via callbacks. This keeps the resolver re-mountable
 * (the parent can swap the plan in place without losing the user's
 * current choice).
 */
import type { BundleConflict, BundleImportPlan } from '@/api/queries';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

export interface BundleConflictResolverProps {
  plan: BundleImportPlan;
  /**
   * User's choice for sha-mismatch resolution. True (default)
   * overwrites the workspace; False preserves it. The parent dialog
   * persists the choice across re-renders.
   */
  useBundleCase: boolean;
  /** Setter for ``useBundleCase``. */
  onUseBundleCaseChange: (next: boolean) => void;
  /**
   * Optional re-export CTA handler. When provided, the
   * ``addfile-missing`` blocker banner shows a "Re-export bundle"
   * button that fires this callback (typically opens the
   * BundleExportDialog from the originating session).
   */
  onReExportClick?: () => void;
}

function shortenSha(sha: string): string {
  return sha.length > 16 ? `${sha.slice(0, 12)}…${sha.slice(-4)}` : sha;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function VersionConflictBanner({ conflict }: { conflict: BundleConflict }) {
  return (
    <div
      role="alert"
      data-testid="bundle-conflict-andes-version"
      className={cn(
        'border-warning/30 bg-warning/10 text-foreground',
        'rounded-[var(--radius-sm)] border px-3 py-2',
      )}
    >
      <p className="text-xs font-semibold">ANDES version mismatch</p>
      <p className="text-foreground/80 mt-0.5 text-xs leading-snug">{conflict.message}</p>
      <p className="text-muted-foreground mt-1 font-mono text-[11px]">
        bundle: {conflict.bundle_andes_version ?? 'unknown'} • installed:{' '}
        {conflict.current_andes_version ?? 'unknown'}
      </p>
    </div>
  );
}

function AddfileMissingBanner({
  conflict,
  onReExportClick,
}: {
  conflict: BundleConflict;
  onReExportClick?: () => void;
}) {
  return (
    <div
      role="alert"
      data-testid={`bundle-conflict-addfile-missing-${conflict.filename ?? 'unknown'}`}
      className={cn(
        'border-danger/30 bg-danger/10 text-foreground',
        'rounded-[var(--radius-sm)] border px-3 py-2',
      )}
    >
      <p className="text-xs font-semibold">Addfile missing from bundle</p>
      <p className="text-foreground/80 mt-0.5 text-xs leading-snug">{conflict.message}</p>
      {onReExportClick !== undefined ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onReExportClick}
          data-testid="bundle-conflict-reexport"
          className="mt-2"
        >
          Re-export bundle
        </Button>
      ) : null}
    </div>
  );
}

function ShaMismatchDiff({
  conflict,
  useBundleCase,
  onUseBundleCaseChange,
}: {
  conflict: BundleConflict;
  useBundleCase: boolean;
  onUseBundleCaseChange: (next: boolean) => void;
}) {
  const bundle = conflict.bundle_meta;
  const workspace = conflict.workspace_meta;
  if (bundle === null || workspace === null) {
    return null;
  }
  return (
    <div
      data-testid={`bundle-conflict-sha-mismatch-${conflict.filename ?? 'unknown'}`}
      className={cn(
        'border-warning/30 bg-warning/5 text-foreground',
        'flex flex-col gap-3 rounded-[var(--radius-sm)] border px-3 py-2',
      )}
    >
      <div>
        <p className="text-xs font-semibold">Workspace already has this case</p>
        <p className="text-foreground/80 mt-0.5 text-xs leading-snug">{conflict.message}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 text-xs">
        <div
          data-testid="bundle-conflict-bundle-side"
          className="border-border bg-muted/30 flex flex-col gap-1 rounded-[var(--radius-sm)] border p-2"
        >
          <p className="text-muted-foreground font-medium">Bundle</p>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-2 gap-y-0.5 font-mono">
            <dt className="text-muted-foreground">name</dt>
            <dd className="truncate">{bundle.filename}</dd>
            <dt className="text-muted-foreground">sha</dt>
            <dd className="truncate" title={bundle.sha256}>
              {shortenSha(bundle.sha256)}
            </dd>
            <dt className="text-muted-foreground">size</dt>
            <dd>{formatBytes(bundle.size_bytes)}</dd>
          </dl>
        </div>
        <div
          data-testid="bundle-conflict-workspace-side"
          className="border-border bg-muted/30 flex flex-col gap-1 rounded-[var(--radius-sm)] border p-2"
        >
          <p className="text-muted-foreground font-medium">Workspace</p>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-2 gap-y-0.5 font-mono">
            <dt className="text-muted-foreground">name</dt>
            <dd className="truncate">{workspace.filename}</dd>
            <dt className="text-muted-foreground">sha</dt>
            <dd className="truncate" title={workspace.sha256}>
              {shortenSha(workspace.sha256)}
            </dd>
            <dt className="text-muted-foreground">size</dt>
            <dd>{formatBytes(workspace.size_bytes)}</dd>
          </dl>
        </div>
      </div>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-muted-foreground text-xs font-medium">Resolution</legend>
        <label className="flex items-start gap-2 text-xs">
          <input
            type="radio"
            name="bundle-conflict-resolution"
            value="bundle"
            checked={useBundleCase}
            onChange={() => onUseBundleCaseChange(true)}
            data-testid="bundle-conflict-pick-bundle"
            className="mt-0.5"
          />
          <span>
            <span className="font-medium">Use bundle</span> — overwrite the workspace copy.
          </span>
        </label>
        <label className="flex items-start gap-2 text-xs">
          <input
            type="radio"
            name="bundle-conflict-resolution"
            value="workspace"
            checked={!useBundleCase}
            onChange={() => onUseBundleCaseChange(false)}
            data-testid="bundle-conflict-pick-workspace"
            className="mt-0.5"
          />
          <span>
            <span className="font-medium">Use workspace original</span> — keep the workspace copy
            and save the bundle&apos;s bytes alongside as <code>.from-bundle</code>.
          </span>
        </label>
      </fieldset>
    </div>
  );
}

export function BundleConflictResolver({
  plan,
  useBundleCase,
  onUseBundleCaseChange,
  onReExportClick,
}: BundleConflictResolverProps) {
  if (plan.conflicts.length === 0) {
    return null;
  }
  return (
    <div data-testid="bundle-conflict-resolver" className="flex flex-col gap-3">
      <p className="text-muted-foreground text-xs font-medium">
        {plan.conflicts.length === 1
          ? 'Resolve 1 conflict before continuing'
          : `Resolve ${plan.conflicts.length} conflicts before continuing`}
      </p>
      {plan.conflicts.map((conflict, idx) => {
        const key = `${conflict.kind}-${conflict.filename ?? 'g'}-${idx}`;
        if (conflict.kind === 'andes-version') {
          return <VersionConflictBanner key={key} conflict={conflict} />;
        }
        if (conflict.kind === 'addfile-missing') {
          return (
            <AddfileMissingBanner key={key} conflict={conflict} onReExportClick={onReExportClick} />
          );
        }
        if (conflict.kind === 'sha-mismatch') {
          return (
            <ShaMismatchDiff
              key={key}
              conflict={conflict}
              useBundleCase={useBundleCase}
              onUseBundleCaseChange={onUseBundleCaseChange}
            />
          );
        }
        return null;
      })}
    </div>
  );
}
