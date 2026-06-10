/**
 * ControllerNode component tests (v3.1 Unit 19).
 *
 * ControllerNode is handle-free (it emits no React Flow edges — the tether
 * to the parent device is drawn inline), so it renders without a
 * ReactFlowProvider. These tests pin the sub-kind data attribute, the label,
 * the orphan warning affordance, and the tether's presence.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { ControllerNode } from '@/components/sld/nodes/ControllerNode';
import type { ControllerSubKind } from '@/lib/controllers';

function nodeProps(
  idx: string,
  subKind: ControllerSubKind,
  extra: Record<string, unknown> = {},
): Parameters<typeof ControllerNode>[0] {
  return {
    id: `controller-${idx}`,
    data: { idx, name: `${idx} name`, kind: 'EXST1', subKind, ...extra },
    selected: false,
    type: 'controller',
    isConnectable: false,
    xPos: 0,
    yPos: 0,
    dragging: false,
    zIndex: 0,
  } as unknown as Parameters<typeof ControllerNode>[0];
}

describe('<ControllerNode />', () => {
  afterEach(cleanup);

  it('renders the idx label + sub-kind data attribute', () => {
    render(
      <ControllerNode
        {...nodeProps('EXST1_1', 'exciter', { connectorDx: -32, connectorDy: 18 })}
      />,
    );
    const node = screen.getByTestId('controller-node-EXST1_1');
    expect(node).toBeInTheDocument();
    expect(node).toHaveAttribute('data-sub-kind', 'exciter');
    expect(node).toHaveAttribute('data-kind', 'controller');
    expect(screen.getByText('EXST1_1')).toBeInTheDocument();
  });

  it('draws a tether when a non-zero connector vector is present', () => {
    const { container } = render(
      <ControllerNode
        {...nodeProps('EXST1_1', 'exciter', { connectorDx: -32, connectorDy: 18 })}
      />,
    );
    expect(container.querySelector('line')).not.toBeNull();
  });

  it('marks an orphan with a warning and draws no tether', () => {
    const { container } = render(
      <ControllerNode
        {...nodeProps('GHOST_1', 'other', { orphan: true, connectorDx: 0, connectorDy: 0 })}
      />,
    );
    const node = screen.getByTestId('controller-node-GHOST_1');
    expect(node).toHaveAttribute('data-orphan', 'true');
    expect(screen.getByText('!')).toBeInTheDocument();
    expect(container.querySelector('line')).toBeNull();
  });

  it('renders a distinct glyph per sub-kind without crashing', () => {
    const kinds: ControllerSubKind[] = [
      'exciter',
      'governor',
      'pss',
      'renewable',
      'measurement',
      'profile',
      'other',
    ];
    for (const k of kinds) {
      const { container } = render(<ControllerNode {...nodeProps(`C_${k}`, k)} />);
      expect(container.querySelector('svg')).not.toBeNull();
      cleanup();
    }
  });
});
