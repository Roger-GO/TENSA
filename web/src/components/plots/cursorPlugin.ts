import type uPlot from 'uplot';
import type { DeltaCursors } from '@/store/plot';

/**
 * What a chart's cursor plugin asks of its owner. Each is read when it is needed
 * (a draw, a click), not once, so the plugin can be built when the chart is and
 * still follow the cursors, the mode and the theme as they change; see
 * ``GroupChart``, which keeps the latest in a ref.
 */
export interface CursorPluginSource {
  cursors: () => DeltaCursors;
  /** Whether a click places a cursor (the mode the plot's Cursors button sets). */
  armed: () => boolean;
  /** Called with the simulation time under the pointer when a click places a cursor. */
  place: (t: number) => void;
  /** Stroke colours of the A and B lines, which read on the current theme. */
  colors: () => { a: string; b: string };
}

/** A pointer that moves farther than this between press and release is a drag (a zoom), not a click. */
export const CLICK_SLOP_PX = 3;

/**
 * A uPlot plugin that draws the A and B cursors as vertical lines across the
 * chart, labelled, and places one where the chart is clicked while the mode is
 * on.
 *
 * Dragging across the chart zooms it (the charts' own ``cursor.drag``), and a
 * drag ends in a mouse-up on the same element as a click does, so a press only
 * counts as a click when the pointer has hardly moved.
 */
export function deltaCursorPlugin(source: CursorPluginSource): uPlot.Plugin {
  return {
    hooks: {
      ready: (u) => {
        let pressedAt: number | null = null;
        u.over.addEventListener('mousedown', (e) => {
          pressedAt = e.clientX;
        });
        u.over.addEventListener('mouseup', (e) => {
          const from = pressedAt;
          pressedAt = null;
          if (from === null || !source.armed()) return;
          if (Math.abs(e.clientX - from) > CLICK_SLOP_PX) return;
          const t = u.posToVal(e.clientX - u.over.getBoundingClientRect().left, 'x');
          if (Number.isFinite(t)) source.place(t);
        });
      },
      draw: (u) => {
        // No canvas to draw on (jsdom has none).
        if (!u.ctx) return;
        const { a, b } = source.cursors();
        const colors = source.colors();
        for (const [label, t, color] of [
          ['A', a, colors.a],
          ['B', b, colors.b],
        ] as const) {
          if (t === null) continue;
          const scale = u.scales['x'];
          if (scale === undefined || scale.min == null || scale.max == null) continue;
          if (t < scale.min || t > scale.max) continue;
          drawLine(u, label, u.valToPos(t, 'x', true), color);
        }
      },
    },
  };
}

/** One labelled vertical line at canvas x ``x`` across the plot area. */
function drawLine(u: uPlot, label: string, x: number, color: string): void {
  const { ctx, bbox } = u;
  const ratio = bbox.width / Math.max(1, u.width);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1, Math.round(1.5 * ratio));
  ctx.setLineDash([4 * ratio, 3 * ratio]);
  ctx.beginPath();
  ctx.moveTo(Math.round(x), bbox.top);
  ctx.lineTo(Math.round(x), bbox.top + bbox.height);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = `${Math.round(11 * ratio)}px sans-serif`;
  ctx.textBaseline = 'top';
  ctx.fillText(label, Math.round(x) + 3 * ratio, bbox.top + 2 * ratio);
  ctx.restore();
}
