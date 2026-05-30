/**
 * JobAnnouncer (v3.1 Phase 3, Unit 11 — a11y).
 *
 * A single visually-hidden ARIA live region that announces background job
 * outcomes to assistive tech. Phase 3's whole purpose is surfacing every
 * action's progress + outcome — including jobs that finish/fail while the
 * Activity panel is collapsed — but the visual surfaces (InFlightChip,
 * ActivityRow status badge) flip silently. A sighted user sees the chip
 * vanish or a row turn red; without this region a screen-reader user would
 * get no notification that a background routine finished or failed.
 *
 * It mounts once at the app root beside ``useJobEventsStream`` and wires off
 * the same ``useJobsStore`` the chip reads. Only NEW terminal transitions
 * are announced (a job whose id was already terminal on the previous render
 * is skipped) so an initial store hydration doesn't replay old outcomes.
 *
 * - ``failed`` → assertive (the user likely needs to act).
 * - ``done`` / ``cancelled`` → polite.
 *
 * The error-surface banners (``role="alert"``) and ``RecoveryBadge``
 * (``aria-live``) already announce FOREGROUND errors; this covers the
 * BACKGROUND outcome whose surface is not mounted.
 */
import { useEffect, useRef, useState } from 'react';
import { useJobsStore, isTerminalStatus } from '@/store/jobs';
import { kindLabel } from '@/components/shell/jobLabels';

const STATUS_VERB: Record<string, string> = {
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};

export function JobAnnouncer() {
  const jobs = useJobsStore((s) => s.jobs);
  // Ids already announced as terminal — so a re-render (or a later non-status
  // patch to the same record) doesn't re-announce.
  const announcedRef = useRef<Set<string>>(new Set());
  const seededRef = useRef(false);
  const [polite, setPolite] = useState('');
  const [assertive, setAssertive] = useState('');

  useEffect(() => {
    // First pass: seed the set with jobs already terminal (store hydration /
    // first mount) WITHOUT announcing them.
    if (!seededRef.current) {
      seededRef.current = true;
      for (const job of Object.values(jobs)) {
        if (isTerminalStatus(job.status)) announcedRef.current.add(job.id);
      }
      return;
    }

    const fresh = { polite: [] as string[], assertive: [] as string[] };
    for (const job of Object.values(jobs)) {
      if (!isTerminalStatus(job.status)) continue;
      if (announcedRef.current.has(job.id)) continue;
      announcedRef.current.add(job.id);
      const verb = STATUS_VERB[job.status] ?? job.status;
      const message = `${kindLabel(job.kind)} ${verb}`;
      if (job.status === 'failed') fresh.assertive.push(message);
      else fresh.polite.push(message);
    }
    if (fresh.assertive.length > 0) setAssertive(fresh.assertive.join('. '));
    if (fresh.polite.length > 0) setPolite(fresh.polite.join('. '));
  }, [jobs]);

  return (
    <>
      <div
        data-testid="job-announcer-polite"
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {polite}
      </div>
      <div
        data-testid="job-announcer-assertive"
        className="sr-only"
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
      >
        {assertive}
      </div>
    </>
  );
}
