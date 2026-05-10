import { useMemo } from 'react';
import { cn } from '@/lib/cn';
import { useAnalyzeStore } from '@/store/analyze';
import type { EigResult } from '@/api/types';

/**
 * EIGDampingChart — bar chart of per-mode damping ratios with the
 * selected mode highlighted (Unit 6 of the v2.0 plan).
 *
 * Rendering: small SVG bar chart. Each bar's height is proportional
 * to the damping ratio (clamped to [-0.5, 1] for visualisation). The
 * selected mode (``useAnalyzeStore.selectedModeId``) gets a primary
 * fill so the linked-selection model is visible across the three
 * EIG views (scatter / table / damping).
 *
 * Click on a bar → ``setSelectedModeId(modeIdx)`` (mirrors the
 * scatter's click-to-select behaviour so the chart is also a
 * navigation surface, not just a read-only view).
 */

const MAX_VISIBLE_BARS = 80;
const SVG_HEIGHT = 120;
const BAR_GAP = 2;

export interface EIGDampingChartProps {
  className?: string;
  result?: EigResult | null;
}

export function EIGDampingChart({ className, result: resultProp }: EIGDampingChartProps) {
  const storeResult = useAnalyzeStore((s) => s.eigResult);
  const selectedModeId = useAnalyzeStore((s) => s.selectedModeId);
  const setSelectedModeId = useAnalyzeStore((s) => s.setSelectedModeId);

  const result = resultProp !== undefined ? resultProp : storeResult;

  const visibleSlice = useMemo(() => {
    if (result === null) return [];
    return result.damping_ratios.slice(0, MAX_VISIBLE_BARS).map((d, i) => ({
      idx: i,
      damping: d,
    }));
  }, [result]);

  if (result === null || result.mode_count === 0) {
    return (
      <div
        data-testid="eig-damping-chart"
        className={cn(
          'border-border bg-muted/20 text-muted-foreground',
          'flex h-full min-h-[80px] items-center justify-center rounded border p-3 text-xs',
          className,
        )}
      >
        {result === null ? 'No EIG result yet.' : 'No damping ratios — case has no dynamic states.'}
      </div>
    );
  }

  const barCount = visibleSlice.length;
  const totalGap = BAR_GAP * Math.max(0, barCount - 1);
  // Min bar width 4px for usability; SVG width scales with bar count.
  const barWidth = 4;
  const svgWidth = barCount * barWidth + totalGap + 8;
  const baselineY = SVG_HEIGHT - 12;
  const heightScale = baselineY - 4; // pixels available above baseline

  return (
    <div
      data-testid="eig-damping-chart"
      className={cn('border-border bg-background flex flex-col rounded border', className)}
    >
      <div className="border-border text-muted-foreground border-b px-2 py-1 text-[10px]">
        Damping ratios — {barCount} of {result.mode_count} bars
        {result.mode_count > MAX_VISIBLE_BARS ? ` (capped at first ${MAX_VISIBLE_BARS})` : ''}
        {selectedModeId !== null ? ` · selected mode ${selectedModeId}` : ''}
      </div>
      <div className="overflow-auto">
        <svg width={svgWidth} height={SVG_HEIGHT} role="img" aria-label="Damping ratios bar chart">
          {/* baseline */}
          <line
            x1={4}
            y1={baselineY}
            x2={svgWidth - 4}
            y2={baselineY}
            className="stroke-border"
            strokeWidth={1}
          />
          {visibleSlice.map((bar) => {
            const isSelected = selectedModeId === bar.idx;
            const clamped = Math.max(-0.5, Math.min(1, bar.damping));
            const barH = Math.max(1, Math.abs(clamped) * heightScale);
            const x = 4 + bar.idx * (barWidth + BAR_GAP);
            const y = clamped >= 0 ? baselineY - barH : baselineY;
            return (
              <rect
                key={bar.idx}
                x={x}
                y={y}
                width={barWidth}
                height={barH}
                data-testid={`eig-damping-bar-${bar.idx}`}
                data-selected={isSelected ? 'true' : 'false'}
                onClick={() => setSelectedModeId(bar.idx)}
                className={cn(
                  'cursor-pointer transition-[fill]',
                  isSelected
                    ? 'fill-primary'
                    : clamped < 0
                      ? 'fill-danger/70'
                      : 'fill-foreground/50 hover:fill-foreground/80',
                )}
              />
            );
          })}
        </svg>
      </div>
    </div>
  );
}
