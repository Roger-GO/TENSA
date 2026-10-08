/**
 * DraftNode: the symbol of an element that was placed on the diagram and is
 * not in the system yet. It says so without colour (a dashed box, the word
 * of its badge), has one size for every kind, and has the ports a connector
 * to its bus leaves by, like a device.
 *
 * React Flow's `Handle` needs a provider, so it is stubbed with an element
 * that shows what it was given.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  return {
    Handle: ({ id, type, position }: { id: string; type: string; position: string }) =>
      React.createElement('span', {
        'data-testid': 'handle',
        'data-handle-id': id,
        'data-handle-type': type,
        'data-handle-position': position,
      }),
    Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
  };
});

import { DraftNode } from '@/components/sld/nodes/DraftNode';
import { DRAFT_NODE_SIZE, type DraftNodeData } from '@/components/sld/drafts';
import { DEVICE_PORT } from '@/components/sld/graph';

function renderNode(data: Partial<DraftNodeData> = {}, selected = false) {
  const whole: DraftNodeData = {
    draft: true,
    idx: 'draft-1',
    name: 'PV generator 6',
    kind: 'PV',
    caption: 'PV 6',
    ready: false,
    summary: 'Missing bus and Sn',
    ...data,
  };
  const props = {
    id: whole.idx,
    data: whole,
    selected,
    type: 'draft',
    isConnectable: true,
    dragging: false,
    zIndex: 0,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  } as unknown as Parameters<typeof DraftNode>[0];
  return render(<DraftNode {...props} />);
}

afterEach(cleanup);

describe('<DraftNode />', () => {
  it('is a dashed box of one size, with the model and idx it has now and an Incomplete badge', () => {
    renderNode();
    const node = screen.getByTestId('draft-node-draft-1');
    expect(node).toHaveAttribute('data-kind', 'draft');
    expect(node).toHaveAttribute('data-draft-kind', 'PV');
    expect(node).toHaveAttribute('data-ready', 'false');
    expect(node.className).toContain('border-dashed');
    expect(node.className).toContain('border-warning');
    expect(node.style.width).toBe(`${DRAFT_NODE_SIZE.width}px`);
    expect(node.style.height).toBe(`${DRAFT_NODE_SIZE.height}px`);
    expect(node).toHaveTextContent('PV 6');
    // The badge says in a word what the colour says.
    expect(screen.getByTestId('draft-badge-draft-1')).toHaveTextContent('Incomplete');
    // What it lacks is in its title, for a pointer that rests on it.
    expect(node).toHaveAttribute(
      'title',
      'Draft PV generator 6: Missing bus and Sn. Not in the system yet.',
    );
  });

  it('says Ready, in the colour of what can be added, once nothing is missing', () => {
    renderNode({ ready: true, summary: 'Ready to add' });
    const node = screen.getByTestId('draft-node-draft-1');
    expect(node).toHaveAttribute('data-ready', 'true');
    expect(node.className).toContain('border-success');
    expect(node.className).not.toContain('border-warning');
    expect(screen.getByTestId('draft-badge-draft-1')).toHaveTextContent('Ready');
  });

  it('is ringed while it is picked', () => {
    renderNode({}, true);
    expect(screen.getByTestId('draft-node-draft-1').className).toContain('ring-2');
  });

  it('has a port at the middle of each face, for the connector to its bus', () => {
    renderNode();
    const ports = screen.getAllByTestId('handle');
    expect(ports.map((p) => p.getAttribute('data-handle-id')).sort()).toEqual(
      Object.values(DEVICE_PORT).sort(),
    );
  });

  it('draws the symbol of its kind, and a plain block for a kind it has none for', () => {
    const { container, unmount } = renderNode({ kind: 'Shunt', caption: 'Shunt SH1' });
    expect(container.querySelectorAll('svg')).toHaveLength(1);
    unmount();
    const other = renderNode({ kind: 'NoSuchKind', caption: 'NoSuchKind' });
    expect(other.container.querySelector('svg rect')).not.toBeNull();
  });
});
