/**
 * ``replayJournal`` re-sends recorded edits to a fresh session, in order, through
 * the endpoints that made them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { replayJournal } from '@/api/replayJournal';
import { parseSessionId } from '@/api/types';
import type { JournalEntry, JournalOp } from '@/store/editJournal';

const SESSION = parseSessionId('sess-new');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function entries(...ops: JournalOp[]): JournalEntry[] {
  return ops.map((op, i) => ({ ...op, rev: i + 1 }));
}

interface Sent {
  method: string;
  path: string;
  body: unknown;
}

describe('replayJournal', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let sent: Sent[];
  let respond: (call: Sent) => Response;

  beforeEach(() => {
    sent = [];
    respond = () => jsonResponse({});
    fetchSpy = vi
      .spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch')
      .mockImplementation(async (input, init) => {
        const call: Sent = {
          method: init?.method ?? 'GET',
          path: String(input),
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        };
        sent.push(call);
        return respond(call);
      }) as ReturnType<typeof vi.spyOn>;
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('sends every operation as the request that made it, in order', async () => {
    const outcome = await replayJournal(
      SESSION,
      entries(
        { op: 'add', model: 'Bus', params: { idx: 1, Vn: 110 } },
        { op: 'edit', model: 'Bus', idx: '1', params: { Vn: 230 } },
        { op: 'delete', model: 'Bus', idx: '1' },
        { op: 'undo' },
        { op: 'reload' },
      ),
    );

    expect(sent).toEqual([
      {
        method: 'POST',
        path: '/api/sessions/sess-new/elements',
        body: { model: 'Bus', params: { idx: 1, Vn: 110 } },
      },
      {
        method: 'PUT',
        path: '/api/sessions/sess-new/elements/Bus/1',
        body: { params: { Vn: 230 } },
      },
      { method: 'DELETE', path: '/api/sessions/sess-new/elements/Bus/1', body: undefined },
      { method: 'POST', path: '/api/sessions/sess-new/undo-last-edit', body: {} },
      { method: 'POST', path: '/api/sessions/sess-new/reload', body: {} },
    ]);
    expect(outcome).toMatchObject({ applied: 5, total: 5, error: null, appliedThroughRev: 5 });
    expect(outcome.clone).toBeNull();
  });

  it('percent-encodes the parts of a path that came from the user', async () => {
    await replayJournal(
      SESSION,
      entries({ op: 'edit', model: 'Bus', idx: 'a/b c', params: { Vn: 1 } }),
    );

    expect(sent[0]?.path).toBe('/api/sessions/sess-new/elements/Bus/a%2Fb%20c');
  });

  it('replays clone edits and reports the stack depths the last one returned', async () => {
    respond = (call) =>
      call.path.endsWith('/undo')
        ? jsonResponse({ model: '', idx: '', param: '', undo_depth: 1, redo_depth: 1 })
        : jsonResponse({
            model: 'EXST1',
            idx: '1',
            param: 'KA',
            new_value: 50,
            undo_depth: 2,
            redo_depth: 0,
          });

    const outcome = await replayJournal(
      SESSION,
      entries(
        { op: 'clone-init' },
        { op: 'clone-edit', model: 'EXST1', idx: '1', param: 'KA', value: 40 },
        { op: 'clone-edit', model: 'EXST1', idx: '1', param: 'KA', value: 50 },
        { op: 'clone-undo' },
      ),
    );

    expect(sent.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/sessions/sess-new/case/clone',
      'PUT /api/sessions/sess-new/case/clone/params/EXST1/1/KA',
      'PUT /api/sessions/sess-new/case/clone/params/EXST1/1/KA',
      'POST /api/sessions/sess-new/case/clone/undo',
    ]);
    expect(sent[1]?.body).toEqual({ value: 40 });
    expect(outcome.clone).toEqual({ initialized: true, undoDepth: 1, redoDepth: 1 });
  });

  it('reports a clone that was only initialised as initialised with nothing to undo', async () => {
    const outcome = await replayJournal(SESSION, entries({ op: 'clone-init' }));

    expect(outcome.clone).toEqual({ initialized: true, undoDepth: 0, redoDepth: 0 });
  });

  it('reports a clone that was reset as gone', async () => {
    const outcome = await replayJournal(
      SESSION,
      entries({ op: 'clone-init' }, { op: 'clone-reset' }),
    );

    expect(outcome.clone).toEqual({ initialized: false, undoDepth: 0, redoDepth: 0 });
  });

  it('stops at the first request the substrate refuses and says how far it got', async () => {
    respond = (call) =>
      call.method === 'PUT'
        ? jsonResponse(
            { type: 'about:blank', title: 'Unprocessable', status: 422, detail: 'bad param' },
            422,
          )
        : jsonResponse({});

    const outcome = await replayJournal(
      SESSION,
      entries(
        { op: 'add', model: 'Bus', params: { idx: 1 } },
        { op: 'add', model: 'Bus', params: { idx: 2 } },
        { op: 'edit', model: 'Bus', idx: '2', params: { nope: 1 } },
        { op: 'add', model: 'Bus', params: { idx: 3 } },
      ),
    );

    expect(sent).toHaveLength(3);
    expect(outcome.applied).toBe(2);
    expect(outcome.total).toBe(4);
    expect(outcome.appliedThroughRev).toBe(2);
    expect(outcome.error).toMatchObject({ status: 422, detail: 'bad param' });
  });

  it('does not throw when the network is gone', async () => {
    fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));

    const outcome = await replayJournal(SESSION, entries({ op: 'undo' }));

    expect(outcome.applied).toBe(0);
    expect(outcome.appliedThroughRev).toBeNull();
    expect(outcome.error).toBeInstanceOf(Error);
  });

  it('does nothing for an empty journal', async () => {
    const outcome = await replayJournal(SESSION, []);

    expect(sent).toEqual([]);
    expect(outcome).toMatchObject({ applied: 0, total: 0, error: null });
  });
});
