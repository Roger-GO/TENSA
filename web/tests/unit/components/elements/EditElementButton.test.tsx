/**
 * EditElementButton — pencil → input → save / cancel cycle.
 *
 * These tests stub the API client so the mutation never actually fires
 * over the network; they assert the lifecycle visually + the param
 * payload passed to the underlying useMutation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { EditElementButton } from '@/components/elements/EditElementButton';
import { useSessionStore } from '@/store/session';
import { parseSessionId } from '@/api/types';
import type { TopologyParamMeta } from '@/api/types';

const putSpy = vi.fn();
/** What the next writes are refused with; `null` lets them through. */
let putError: Error | null = null;

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock('@/lib/toast', () => ({ toast: toastMock }));

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    andesClient: {
      get: vi.fn(),
      post: vi.fn(),
      put: (path: string, opts: { body?: unknown }) => {
        putSpy(path, opts.body);
        if (putError !== null) return Promise.reject(putError);
        return Promise.resolve({
          idx: '1',
          name: 'BUS1',
          kind: 'Bus',
          params: { Vn: 110 },
        });
      },
    },
  };
});

function withQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

const VnMeta: TopologyParamMeta = {
  name: 'Vn',
  kind: 'number',
  required: true,
  unit: 'kV',
};

describe('EditElementButton', () => {
  beforeEach(() => {
    putSpy.mockClear();
    putError = null;
    vi.clearAllMocks();
    useSessionStore.setState({ sessionId: parseSessionId('test-session-id') });
  });

  it('renders the value read-only when not enabled', () => {
    render(
      withQueryClient(
        <EditElementButton model="Bus" idx="1" meta={VnMeta} value={100} enabled={false} />,
      ),
    );
    expect(screen.queryByLabelText('Edit Vn')).toBeNull();
    expect(screen.getByText('100')).toBeInTheDocument();
  });

  it('names the pencil when the pointer rests on it', () => {
    render(
      withQueryClient(<EditElementButton model="Bus" idx="1" meta={VnMeta} value={100} enabled />),
    );
    expect(screen.getByLabelText('Edit Vn')).toHaveAttribute('title', 'Edit Vn');
  });

  it('shows pencil → input → save cycle and posts the new value', async () => {
    const user = userEvent.setup();
    const onUpdated = vi.fn();
    render(
      withQueryClient(
        <EditElementButton
          model="Bus"
          idx="1"
          meta={VnMeta}
          value={100}
          enabled
          onUpdated={onUpdated}
        />,
      ),
    );
    await user.click(screen.getByLabelText('Edit Vn'));
    const input = screen.getByTestId('edit-input-Vn').querySelector('input');
    expect(input).not.toBeNull();
    await user.clear(input!);
    await user.type(input!, '110');
    await user.click(screen.getByLabelText('Save Vn'));
    await waitFor(() => {
      expect(putSpy).toHaveBeenCalled();
    });
    const [path, body] = putSpy.mock.calls[0] ?? [];
    expect(path).toContain('/sessions/test-session-id/elements/Bus/1');
    expect(body).toEqual({ params: { Vn: 110 } });
    expect(onUpdated).toHaveBeenCalledWith(110);
  });

  it('confirms a saved value with a toast that names it and says how to take it back', async () => {
    const user = userEvent.setup();
    render(
      withQueryClient(<EditElementButton model="Bus" idx="1" meta={VnMeta} value={100} enabled />),
    );
    await user.click(screen.getByLabelText('Edit Vn'));
    expect(toastMock.success).not.toHaveBeenCalled();
    const input = screen.getByTestId('edit-input-Vn').querySelector('input');
    await user.clear(input!);
    await user.type(input!, '110{Enter}');
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledTimes(1));
    expect(toastMock.success).toHaveBeenCalledWith(
      'Changed Vn of Bus 1',
      expect.objectContaining({
        description: expect.stringMatching(/^Undo \(Ctrl\+Z or Edit > Undo\) takes it back\. /),
      }),
    );
  });

  it('confirms nothing for a value the server refused, and says why beside it', async () => {
    const user = userEvent.setup();
    putError = new Error('Vn must be positive');
    render(
      withQueryClient(<EditElementButton model="Bus" idx="1" meta={VnMeta} value={100} enabled />),
    );
    await user.click(screen.getByLabelText('Edit Vn'));
    const input = screen.getByTestId('edit-input-Vn').querySelector('input');
    await user.clear(input!);
    await user.type(input!, '-5{Enter}');
    expect(await screen.findByTestId('edit-error-Vn')).toHaveTextContent('Vn must be positive');
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('rejects non-numeric input on a number field with inline error', async () => {
    const user = userEvent.setup();
    render(
      withQueryClient(<EditElementButton model="Bus" idx="1" meta={VnMeta} value={100} enabled />),
    );
    await user.click(screen.getByLabelText('Edit Vn'));
    const input = screen.getByTestId('edit-input-Vn').querySelector('input');
    await user.clear(input!);
    await user.type(input!, 'abc');
    await user.click(screen.getByLabelText('Save Vn'));
    expect(screen.getByTestId('edit-error-Vn')).toHaveTextContent('finite number');
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('cancel reverts the draft and exits edit mode', async () => {
    const user = userEvent.setup();
    render(
      withQueryClient(<EditElementButton model="Bus" idx="1" meta={VnMeta} value={100} enabled />),
    );
    await user.click(screen.getByLabelText('Edit Vn'));
    const input = screen.getByTestId('edit-input-Vn').querySelector('input');
    await user.clear(input!);
    await user.type(input!, '999');
    await user.click(screen.getByLabelText('Cancel editing Vn'));
    expect(screen.queryByLabelText('Cancel editing Vn')).toBeNull();
    expect(screen.getByText('100')).toBeInTheDocument();
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('Enter key submits, Escape cancels', async () => {
    const user = userEvent.setup();
    render(
      withQueryClient(<EditElementButton model="Bus" idx="1" meta={VnMeta} value={100} enabled />),
    );
    await user.click(screen.getByLabelText('Edit Vn'));
    const input = screen.getByTestId('edit-input-Vn').querySelector('input');
    expect(input).toBe(document.activeElement);
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('edit-input-Vn')).toBeNull();

    await user.click(screen.getByLabelText('Edit Vn'));
    const input2 = screen.getByTestId('edit-input-Vn').querySelector('input');
    await user.clear(input2!);
    await user.type(input2!, '120');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
  });
});
