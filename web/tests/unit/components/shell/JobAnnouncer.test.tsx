/**
 * Tests for ``<JobAnnouncer />``: the live regions that say when a background
 * job ends. Only an end that happens while it is mounted is said; jobs that
 * had ended before (a store hydrated from the server) are not.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { JobAnnouncer } from '@/components/shell/JobAnnouncer';
import { useJobsStore, type JobRecord, type JobStatus } from '@/store/jobs';

function job(id: string, status: JobStatus, kind: JobRecord['kind'] = 'pflow'): JobRecord {
  return {
    id,
    kind,
    status,
    started_at: 1,
    updated_at: 1,
    can_cancel: false,
    request_summary: {},
    repeated_count: 0,
  };
}

function setJobs(...jobs: JobRecord[]) {
  useJobsStore.setState({ jobs: Object.fromEntries(jobs.map((j) => [j.id, j])) });
}

describe('<JobAnnouncer />', () => {
  beforeEach(() => {
    useJobsStore.setState({ jobs: {}, dismissedJobIds: [] });
  });
  afterEach(() => {
    useJobsStore.setState({ jobs: {}, dismissedJobIds: [] });
  });

  it('says nothing of the jobs that had ended before it mounted', () => {
    setJobs(job('old-done', 'done'), job('old-failed', 'failed'));
    render(<JobAnnouncer />);
    expect(screen.getByTestId('job-announcer-polite')).toHaveTextContent('');
    expect(screen.getByTestId('job-announcer-assertive')).toHaveTextContent('');
  });

  it('says a job that fails assertively and one that finishes politely', () => {
    setJobs(job('a', 'running'), job('b', 'running', 'eig'));
    render(<JobAnnouncer />);
    act(() => setJobs(job('a', 'failed'), job('b', 'running', 'eig')));
    expect(screen.getByTestId('job-announcer-assertive')).toHaveTextContent('Power flow failed');
    act(() => setJobs(job('a', 'failed'), job('b', 'done', 'eig')));
    expect(screen.getByTestId('job-announcer-polite')).toHaveTextContent(
      'Eigenvalue analysis done',
    );
  });

  it('says an end once, whatever else changes on the job afterwards', () => {
    render(<JobAnnouncer />);
    act(() => setJobs(job('a', 'done')));
    expect(screen.getByTestId('job-announcer-polite')).toHaveTextContent('Power flow done');
    act(() => setJobs(job('a', 'done'), job('c', 'done', 'cpf')));
    expect(screen.getByTestId('job-announcer-polite')).toHaveTextContent('CPF done');
    expect(screen.getByTestId('job-announcer-polite')).not.toHaveTextContent('Power flow');
  });
});
