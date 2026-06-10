import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  useAddProfile,
  useDeleteProfile,
  useListProfiles,
  useUploadProfile,
  useCurrentTopology,
} from '@/api/queries';
import { useSessionStore } from '@/store/session';
import { useProfilesStore } from '@/store/profiles';
import { ProblemDetailsError } from '@/api/client';
import { cn } from '@/lib/cn';

/**
 * ProfileImportDialog — modal dialog for importing a CSV / XLSX
 * hourly profile and assigning it to a load or generator (Unit 15).
 *
 * Flow:
 *
 *   1. user picks file (.csv or .xlsx) → ``useUploadProfile`` writes
 *      it to ``<workspace>/profiles/<uuid>.xlsx`` and returns the
 *      absolute path.
 *   2. user fills in target model + dev + dests + sheet + fields +
 *      tkey + mode (mode is fixed to 1 with a tooltip explaining
 *      mode=2 is unsupported per the Unit 1a spike).
 *   3. user clicks "Stage profile" → ``useAddProfile`` posts the
 *      ``ss.add('TimeSeries', ...)`` payload.
 *   4. dialog stays open so the user can stage more profiles or
 *      delete a wrong staging via the "currently staged" list.
 *
 * The dialog deliberately keeps the form minimal — researchers know
 * which device they're targeting (they loaded the case). Field names
 * match the ANDES surface 1:1 to keep the substrate-mapping clear.
 */

export interface ProfileImportDialogProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
}

export function ProfileImportDialog({ open, onOpenChange }: ProfileImportDialogProps) {
  const sessionId = useSessionStore((s) => s.sessionId);
  const topology = useCurrentTopology();
  // Subscribe to the listProfiles query whenever the dialog is open so
  // the staged list stays in sync after add/delete mutations.
  const list = useListProfiles();
  const stagedProfiles = useProfilesStore((s) => s.profiles);
  const uploadMutation = useUploadProfile();
  const addMutation = useAddProfile();
  const deleteMutation = useDeleteProfile();

  // Form state.
  const [uploadedPath, setUploadedPath] = useState<string | null>(null);
  const [uploadedFilename, setUploadedFilename] = useState<string | null>(null);
  const [sheet, setSheet] = useState<string>('profile');
  const [fields, setFields] = useState<string>('p0');
  const [dests, setDests] = useState<string>('p0');
  const [tkey, setTkey] = useState<string>('t');
  const [model, setModel] = useState<string>('PQ');
  const [dev, setDev] = useState<string>('');
  const [serverError, setServerError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Reset draft each time the dialog opens. Stale state from a prior
  // open shouldn't leak into the next session.
  useEffect(() => {
    if (open) {
      setUploadedPath(null);
      setUploadedFilename(null);
      setSheet('profile');
      setFields('p0');
      setDests('p0');
      setTkey('t');
      setModel('PQ');
      setDev('');
      setServerError(null);
      void list.refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Available target devices for the picked model. Keep it simple —
  // the user mostly imports profiles for loads (PQ) or generators
  // (PV / Slack). Empty when topology is missing.
  const availableDevices = useMemo(() => {
    if (!topology) return [];
    if (model === 'PQ') return topology.loads.filter((d) => d.kind === 'PQ');
    if (model === 'PV') return topology.generators.filter((d) => d.kind === 'PV');
    if (model === 'Slack') return topology.generators.filter((d) => d.kind === 'Slack');
    return [];
  }, [topology, model]);

  const handleFilePick = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    if (!file || !sessionId) return;
    setServerError(null);
    try {
      const result = await uploadMutation.mutateAsync({ sessionId, file });
      setUploadedPath(result.profile_path);
      setUploadedFilename(file.name);
      // CSV uploads land under sheet name "profile"; xlsx uploads
      // keep their sheet names. Pre-fill "profile" — it's the
      // substrate's CSV→XLSX convention.
      if (file.name.toLowerCase().endsWith('.csv')) {
        setSheet('profile');
      }
    } catch (err) {
      if (err instanceof ProblemDetailsError) {
        setServerError(err.detail ?? err.title ?? `Upload rejected (${err.status})`);
      } else if (err instanceof Error) {
        setServerError(err.message);
      } else {
        setServerError('Upload failed');
      }
    }
  };

  const canStage =
    sessionId !== null &&
    uploadedPath !== null &&
    sheet.trim().length > 0 &&
    fields.trim().length > 0 &&
    dests.trim().length > 0 &&
    tkey.trim().length > 0 &&
    model.trim().length > 0 &&
    dev.trim().length > 0 &&
    !addMutation.isPending;

  const handleStage = async () => {
    if (!sessionId || !uploadedPath) return;
    setServerError(null);
    try {
      await addMutation.mutateAsync({
        sessionId,
        body: {
          profile_path: uploadedPath,
          sheet: sheet.trim(),
          fields: fields.trim(),
          dests: dests.trim(),
          tkey: tkey.trim(),
          model: model.trim(),
          dev: dev.trim(),
          mode: 1,
        },
      });
      // Clear the upload so the user must re-pick a file for the
      // next staging — a single file is one TimeSeries device per the
      // ANDES contract.
      setUploadedPath(null);
      setUploadedFilename(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err) {
      if (err instanceof ProblemDetailsError) {
        setServerError(err.detail ?? err.title ?? `Stage rejected (${err.status})`);
      } else if (err instanceof Error) {
        setServerError(err.message);
      } else {
        setServerError('Stage failed');
      }
    }
  };

  const handleDelete = async (idx: string) => {
    if (!sessionId) return;
    setServerError(null);
    try {
      await deleteMutation.mutateAsync({ sessionId, idx });
    } catch (err) {
      if (err instanceof ProblemDetailsError) {
        setServerError(err.detail ?? err.title ?? `Delete rejected (${err.status})`);
      } else if (err instanceof Error) {
        setServerError(err.message);
      } else {
        setServerError('Delete failed');
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="profile-import-dialog" className="max-w-xl">
        <DialogTitle>Import time-series profile</DialogTitle>
        <DialogDescription className="mt-1">
          Upload a CSV or XLSX file with timestamp + value columns, then assign it to a load or
          generator parameter. ANDES applies the values at exact step times during TDS.
        </DialogDescription>

        {/* Currently-staged list */}
        <section className="mt-3" aria-labelledby="profiles-staged-heading">
          <h3
            id="profiles-staged-heading"
            className="text-foreground text-xs font-medium uppercase"
          >
            Currently staged ({stagedProfiles.length})
          </h3>
          {stagedProfiles.length === 0 ? (
            <p className="text-muted-foreground mt-1 text-xs">
              Time-series profiles drive loads with CSV data during TDS. Upload a CSV to attach a
              profile.
            </p>
          ) : (
            <ul data-testid="profiles-staged-list" className="mt-1 flex flex-col gap-1">
              {stagedProfiles.map((p) => {
                const idxStr = String(p.idx);
                const tgtModel = String(p.params?.model ?? '?');
                const tgtDev = String(p.params?.dev ?? '?');
                return (
                  <li
                    key={idxStr}
                    className="bg-muted flex items-center gap-2 rounded px-2 py-1 text-xs"
                    data-testid={`profile-staged-item-${idxStr}`}
                  >
                    <span className="font-mono">{idxStr}</span>
                    <span className="text-muted-foreground">
                      → {tgtModel}.{tgtDev}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleDelete(idxStr)}
                      disabled={deleteMutation.isPending}
                      aria-label={`Delete ${idxStr}`}
                      data-testid={`profile-delete-${idxStr}`}
                      className="text-muted-foreground hover:text-foreground ml-auto"
                    >
                      ×
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Step 1: file upload */}
        <section className="mt-3" aria-labelledby="profile-upload-heading">
          <h3 id="profile-upload-heading" className="text-foreground text-xs font-medium uppercase">
            1. Upload profile file
          </h3>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.xlsx"
            onChange={handleFilePick}
            disabled={uploadMutation.isPending}
            data-testid="profile-file-input"
            className="mt-1 text-xs"
          />
          {uploadMutation.isPending && (
            <p className="text-muted-foreground mt-1 text-xs">Uploading…</p>
          )}
          {uploadedFilename && uploadedPath && (
            <p
              className="text-muted-foreground mt-1 text-xs"
              data-testid="profile-upload-confirmation"
            >
              Uploaded {uploadedFilename}
            </p>
          )}
        </section>

        {/* Step 2: target assignment */}
        <section className="mt-3" aria-labelledby="profile-target-heading">
          <h3 id="profile-target-heading" className="text-foreground text-xs font-medium uppercase">
            2. Target assignment
          </h3>
          <div className="mt-1 grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-0.5">
              <label
                htmlFor="profile-model-input"
                className="text-muted-foreground text-[10px] font-medium uppercase"
              >
                Model
              </label>
              <select
                id="profile-model-input"
                value={model}
                onChange={(e) => {
                  setModel(e.target.value);
                  setDev('');
                }}
                data-testid="profile-model-input"
                className="bg-background border-border h-7 rounded border px-2 text-xs"
              >
                <option value="PQ">PQ (load)</option>
                <option value="PV">PV (generator)</option>
                <option value="Slack">Slack</option>
              </select>
            </div>
            <div className="flex flex-col gap-0.5">
              <label
                htmlFor="profile-dev-input"
                className="text-muted-foreground text-[10px] font-medium uppercase"
              >
                Device
              </label>
              <select
                id="profile-dev-input"
                value={dev}
                onChange={(e) => setDev(e.target.value)}
                data-testid="profile-dev-input"
                className="bg-background border-border h-7 rounded border px-2 text-xs"
              >
                <option value="">— pick a device —</option>
                {availableDevices.map((d) => (
                  <option key={String(d.idx)} value={String(d.idx)}>
                    {String(d.idx)} {d.name ? `— ${d.name}` : ''}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-0.5">
              <label
                htmlFor="profile-fields-input"
                className="text-muted-foreground text-[10px] font-medium uppercase"
              >
                Source columns
              </label>
              <input
                id="profile-fields-input"
                type="text"
                value={fields}
                onChange={(e) => setFields(e.target.value)}
                placeholder="p0"
                data-testid="profile-fields-input"
                className={cn(
                  'bg-background border-border h-7 rounded border px-2 text-xs',
                  fields.trim().length === 0 && 'border-danger',
                )}
              />
            </div>
            <div className="flex flex-col gap-0.5">
              <label
                htmlFor="profile-dests-input"
                className="text-muted-foreground text-[10px] font-medium uppercase"
              >
                Target fields
              </label>
              <input
                id="profile-dests-input"
                type="text"
                value={dests}
                onChange={(e) => setDests(e.target.value)}
                placeholder="p0"
                data-testid="profile-dests-input"
                className={cn(
                  'bg-background border-border h-7 rounded border px-2 text-xs',
                  dests.trim().length === 0 && 'border-danger',
                )}
              />
            </div>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-0.5">
              <label
                htmlFor="profile-sheet-input"
                className="text-muted-foreground text-[10px] font-medium uppercase"
              >
                Sheet
              </label>
              <input
                id="profile-sheet-input"
                type="text"
                value={sheet}
                onChange={(e) => setSheet(e.target.value)}
                data-testid="profile-sheet-input"
                className="bg-background border-border h-7 rounded border px-2 text-xs"
              />
            </div>
            <div className="flex flex-col gap-0.5">
              <label
                htmlFor="profile-tkey-input"
                className="text-muted-foreground text-[10px] font-medium uppercase"
              >
                Time column
              </label>
              <input
                id="profile-tkey-input"
                type="text"
                value={tkey}
                onChange={(e) => setTkey(e.target.value)}
                data-testid="profile-tkey-input"
                className="bg-background border-border h-7 rounded border px-2 text-xs"
              />
            </div>
          </div>

          <p className="text-muted-foreground mt-2 text-[11px]" data-testid="profile-mode-note">
            Mode 1 (exact-step) is the only supported mode — interpolation raises
            NotImplementedError in ANDES (per Unit 1a spike). The substrate forces mode=1 on every
            staging.
          </p>
        </section>

        {serverError !== null && (
          <p role="alert" data-testid="profile-server-error" className="text-danger mt-2 text-xs">
            {serverError}
          </p>
        )}

        <DialogFooter className="mt-4">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            data-testid="profile-cancel"
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={handleStage}
            disabled={!canStage}
            data-testid="profile-stage-submit"
          >
            {addMutation.isPending
              ? 'Staging…'
              : uploadedPath === null
                ? 'Upload a file first'
                : dev.trim().length === 0
                  ? 'Pick a device'
                  : 'Stage profile'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
