/**
 * Tests for the COMTRADE export client: a run's columns go to `POST /comtrade`
 * and the archive comes back as a Blob.
 *
 * What the request holds is covered in `tests/unit/lib/comtrade.test.ts`; these
 * check that it is sent, and what comes of each answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProblemDetailsError } from '@/api/client';
import { ExportRefusedError } from '@/components/export/exportError';
import { exportRunToComtrade } from '@/components/export/exportToComtrade';
import { MAX_COMTRADE_VALUES } from '@/lib/comtrade';
import { useRunsStore } from '@/store/runs';
import type { RunRecord } from '@/store/runs';

const originalFetch = globalThis.fetch;

function seed(columns: Record<string, number[]>, t: number[]): RunRecord {
  useRunsStore.getState().startRun({
    runId: '1a2b3c4d5e6f',
    tf: 10,
    columnNames: Object.keys(columns),
    caseName: 'ieee14',
  });
  if (t.length > 0) {
    useRunsStore.getState().appendFrame('1a2b3c4d5e6f', {
      t: new Float64Array(t),
      columns: Object.fromEntries(
        Object.entries(columns).map(([name, values]) => [name, new Float64Array(values)]),
      ),
    });
  }
  return useRunsStore.getState().runs['1a2b3c4d5e6f']!;
}

beforeEach(() => {
  useRunsStore.setState({ runs: {}, activeRunId: null, overlayRunIds: new Set(), runCount: 0 });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('exportRunToComtrade', () => {
  it('posts the columns asked for and returns the archive the substrate answers with', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
        status: 200,
        headers: { 'Content-Type': 'application/zip' },
      }),
    );
    globalThis.fetch = fetchSpy as typeof fetch;
    const run = seed({ Bus_1_v: [1, 0.9], Bus_1_a: [0, 0.1], Gen_1_omega: [1, 1.001] }, [0, 0.5]);

    const blob = await exportRunToComtrade(run, ['Bus_1_v', 'Gen_1_omega']);

    expect(blob?.size).toBe(4);
    expect(blob?.type).toBe('application/zip');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('/api/comtrade');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toMatchObject({
      t: [0, 0.5],
      channels: [
        { name: 'Bus_1_v', unit: 'pu', values: [1, 0.9] },
        { name: 'Gen_1_omega', unit: 'pu', values: [1, 1.001] },
      ],
      name: 'ieee14_1a2b3c4d',
      station: 'ieee14',
      device: 'TENSA TDS #1',
    });
  });

  it('asks nothing of the substrate when the run has nothing to write', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;

    expect(await exportRunToComtrade(seed({ Bus_1_v: [] }, []), ['Bus_1_v'])).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a run over the limit before sending it', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;
    const run = seed({ Bus_1_v: [1, 1] }, [0, 1]);

    await expect(
      exportRunToComtrade({ ...run, seqCount: MAX_COMTRADE_VALUES + 1 }, ['Bus_1_v']),
    ).rejects.toBeInstanceOf(ExportRefusedError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws the substrate's reason when it refuses the signals", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          type: 'about:blank',
          title: 'Unprocessable Content',
          status: 422,
          detail: 't must not decrease: t[2] = 1 is earlier than t[1] = 2',
        }),
        { status: 422, headers: { 'Content-Type': 'application/json' } },
      ),
    ) as typeof fetch;
    const run = seed({ Bus_1_v: [1, 1] }, [0, 1]);

    const failure = exportRunToComtrade(run, ['Bus_1_v']);

    await expect(failure).rejects.toBeInstanceOf(ProblemDetailsError);
    await expect(failure).rejects.toMatchObject({
      status: 422,
      detail: 't must not decrease: t[2] = 1 is earlier than t[1] = 2',
    });
  });
});
