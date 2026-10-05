import { useCallback, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { useAnalyzeStore } from '@/store/analyze';
import { useTheme } from '@/lib/useTheme';
import { ExportMenu } from '@/components/export/ExportMenu';
import { elementToPng } from '@/components/export/exportToPng';
import { useExportCaseName } from '@/components/export/useExportCaseName';
import { busColor } from './CPFCurveChart';
import { cpfGeneratorsToCsv } from './analyzeExport';
import {
  axisSymbol,
  generatorName,
  hasLowerBranch,
  limitName,
  limitsSummary,
  noseLimitEvent,
  releaseCaution,
} from '@/lib/cpfOptions';
import type { CpfGeneratorTrace, CpfLimitEvent, CpfResult } from '@/api/types';

/**
 * CpfGeneratorPanel: what the generators did along a CPF path.
 *
 * A nose curve shows where the voltage gives way, and not why. This panel
 * is the other half: each PV and slack generator's reactive output against
 * lambda (MVAr), and the list of generators held at a limit with the lambda
 * at which each got there. One sentence says whether limits were enforced,
 * and another, when the nose is where a generator ran out of reactive power,
 * names it: that is a limit-induced collapse and not the smooth fold of the
 * curve, which is the difference a study of the margin turns on.
 *
 * The chart draws up to ``maxVisible`` generators at first: those that reached
 * a limit along the path, then those whose output moved most. Every generator
 * has a chip to add or remove it, and pointing at a line or chip names that
 * generator's Qmin and Qmax on the chart and draws each as a dashed line where
 * it falls within the plot.
 *
 * ANDES's limiter never lets go of a generator it holds. Where a held
 * generator's voltage came back across its set-point (the server marks the
 * step), the table says from where and a line under the summary says what
 * that does to the curve.
 *
 * Renders nothing for a result without generators (a run kept from before the
 * server reported them).
 *
 * Test hooks: ``cpf-generators`` (the card), ``cpf-generators-summary``,
 * ``cpf-generators-nose``, ``cpf-generators-events`` with
 * ``cpf-generators-event-{model}-{idx}`` rows,
 * ``cpf-generators-line-{model}-{idx}``, ``cpf-generators-chip-{model}-{idx}``,
 * ``cpf-generators-limits-readout`` and ``cpf-generators-limit-{qmax|qmin}``.
 */
export interface CpfGeneratorPanelProps {
  /** Override for tests and for the QV panel; usually the analyze store's result. */
  result?: CpfResult | null;
  className?: string;
  /** How many generators the chart draws before any is toggled. */
  maxVisible?: number;
}

const SVG_WIDTH = 480;
const SVG_HEIGHT = 220;
const PADDING_LEFT = 48;
const PADDING_RIGHT = 16;
const PADDING_TOP = 10;
const PADDING_BOTTOM = 30;
const DEFAULT_MAX_VISIBLE = 8;

/** A generator's key within one result: PV and Slack idx are separate ranges. */
// eslint-disable-next-line react-refresh/only-export-components
export function generatorKey(of: { model: string; idx: string }): string {
  return `${of.model}-${of.idx}`;
}

/**
 * The generators to draw first: those that reached a limit along the path, in
 * the order they did, then the rest by how much their output moved.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function pickDefaultGenerators(result: CpfResult, max: number): string[] {
  const generators = result.generators ?? [];
  const picked: string[] = [];
  for (const event of result.limit_events ?? []) {
    if (event.step > 0 && picked.length < max) picked.push(generatorKey(event));
  }
  const swing = (g: CpfGeneratorTrace) =>
    g.q.length === 0 ? 0 : Math.max(...g.q) - Math.min(...g.q);
  const rest = generators
    .filter((g) => !picked.includes(generatorKey(g)))
    .sort((a, b) => swing(b) - swing(a));
  for (const g of rest) {
    if (picked.length >= max) break;
    picked.push(generatorKey(g));
  }
  return picked;
}

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function CpfGeneratorPanel({
  result: resultProp,
  className,
  maxVisible = DEFAULT_MAX_VISIBLE,
}: CpfGeneratorPanelProps) {
  const storeResult = useAnalyzeStore((s) => s.cpfResult);
  const result = resultProp !== undefined ? resultProp : storeResult;
  const { resolvedTheme } = useTheme();

  const defaultVisible = useMemo(
    () => (result === null ? [] : pickDefaultGenerators(result, maxVisible)),
    [result, maxVisible],
  );
  const [visibleOverride, setVisibleOverride] = useState<string[] | null>(null);
  const visible = visibleOverride ?? defaultVisible;
  const [hovered, setHovered] = useState<string | null>(null);

  const cardRef = useRef<HTMLDivElement | null>(null);
  const caseName = useExportCaseName();
  const onExportCsv = useCallback(
    () => (result === null ? null : cpfGeneratorsToCsv(result)),
    [result],
  );
  const onExportPng = useCallback(async () => {
    const el = cardRef.current;
    return el === null ? null : await elementToPng(el);
  }, []);

  const generators = result?.generators ?? [];
  if (result === null || generators.length === 0 || result.lambdas.length === 0) return null;

  const events = result.limit_events ?? [];
  const symbol = axisSymbol(result);
  const summary = limitsSummary(result);
  const atNose = noseLimitEvent(result);
  const caution = releaseCaution(result);
  const lowerBranch = hasLowerBranch(result);
  const drawn = generators.filter((g) => visible.includes(generatorKey(g)));
  const hoveredGenerator = generators.find((g) => generatorKey(g) === hovered) ?? null;

  // The viewport covers what is drawn. Pointing at a generator does not move it:
  // a limit far from the curves is named in the readout and not drawn.
  const xMin = Math.min(...result.lambdas);
  const xMaxRaw = Math.max(...result.lambdas);
  const xMax = xMaxRaw === xMin ? xMin + 1 : xMaxRaw;
  const values = drawn.flatMap((g) => g.q);
  let yMin = values.length > 0 ? Math.min(...values) : 0;
  let yMax = values.length > 0 ? Math.max(...values) : 1;
  if (yMin === yMax) {
    yMin -= 1;
    yMax += 1;
  } else {
    const pad = (yMax - yMin) * 0.05;
    yMin -= pad;
    yMax += pad;
  }
  const plotW = SVG_WIDTH - PADDING_LEFT - PADDING_RIGHT;
  const plotH = SVG_HEIGHT - PADDING_TOP - PADDING_BOTTOM;
  const xToPx = (x: number) => PADDING_LEFT + ((x - xMin) / (xMax - xMin)) * plotW;
  const yToPx = (y: number) => PADDING_TOP + ((yMax - y) / (yMax - yMin)) * plotH;

  const toggle = (key: string) =>
    setVisibleOverride((current) => {
      const base = current ?? defaultVisible;
      return base.includes(key) ? base.filter((k) => k !== key) : [...base, key];
    });

  return (
    <div
      ref={cardRef}
      data-testid="cpf-generators"
      className={cn('border-border bg-background flex flex-col rounded border', className)}
    >
      <div
        className={cn(
          'border-border text-muted-foreground flex items-center justify-between gap-2',
          'border-b px-2 py-0.5 text-[10px]',
        )}
      >
        <span>
          Generator reactive power along the path: {generators.length}{' '}
          {generators.length === 1 ? 'generator' : 'generators'}
        </span>
        <ExportMenu
          formats={['csv', 'png']}
          panel={result.mode === 'qv' ? 'cpf-qv-generators' : 'cpf-pv-generators'}
          caseName={caseName}
          onExportCsv={onExportCsv}
          onExportPng={onExportPng}
          className="h-6 px-2"
        />
      </div>

      {summary !== null || atNose !== null || caution !== null ? (
        <div className="border-border flex flex-col gap-1 border-b px-2 py-1.5 text-[11px] leading-snug">
          {summary !== null ? (
            <p data-testid="cpf-generators-summary" className="text-foreground">
              {summary}
            </p>
          ) : null}
          {atNose !== null ? (
            <p data-testid="cpf-generators-nose" className="text-foreground font-medium">
              The nose is where {generatorName(atNose)} (bus {atNose.bus}) reached{' '}
              {limitName(atNose.limit)}, at {symbol} = {atNose.lam.toFixed(4)}. With no reactive
              power left there the path has nowhere to go on: a limit-induced collapse, not a smooth
              fold of the curve.
            </p>
          ) : null}
          {caution !== null ? (
            <p data-testid="cpf-generators-release-caution" className="text-muted-foreground">
              {caution}
            </p>
          ) : null}
        </div>
      ) : null}

      {events.length > 0 ? (
        <EventsTable
          events={events}
          symbol={symbol}
          axis={result.lambdas}
          noseIdx={result.nose_idx}
          full={lowerBranch}
        />
      ) : null}

      <svg
        viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
        className="mx-auto w-full"
        style={{ aspectRatio: `${SVG_WIDTH} / ${SVG_HEIGHT}`, maxWidth: 760 }}
        role="img"
        aria-label="Generator reactive power along the CPF path"
      >
        <line
          x1={PADDING_LEFT}
          y1={PADDING_TOP + plotH}
          x2={PADDING_LEFT + plotW}
          y2={PADDING_TOP + plotH}
          className="stroke-border"
          strokeWidth={1}
        />
        <line
          x1={PADDING_LEFT}
          y1={PADDING_TOP}
          x2={PADDING_LEFT}
          y2={PADDING_TOP + plotH}
          className="stroke-border"
          strokeWidth={1}
        />
        <text
          x={PADDING_LEFT + plotW / 2}
          y={SVG_HEIGHT - 6}
          textAnchor="middle"
          className="fill-muted-foreground text-[9px]"
        >
          {result.mode === 'qv' ? 'Q injection (pu)' : 'lambda'}
        </text>
        <text
          x={10}
          y={PADDING_TOP + plotH / 2}
          transform={`rotate(-90 10 ${PADDING_TOP + plotH / 2})`}
          textAnchor="middle"
          className="fill-muted-foreground text-[9px]"
        >
          Reactive power (MVAr)
        </text>
        {[yMin, (yMin + yMax) / 2, yMax].map((yVal) => (
          <text
            key={`yt-${yVal}`}
            x={PADDING_LEFT - 4}
            y={yToPx(yVal) + 3}
            textAnchor="end"
            className="fill-muted-foreground text-[8px]"
          >
            {yVal.toFixed(1)}
          </text>
        ))}
        {[xMin, (xMin + xMax) / 2, xMax].map((xVal) => (
          <text
            key={`xt-${xVal}`}
            x={xToPx(xVal)}
            y={PADDING_TOP + plotH + 12}
            textAnchor="middle"
            className="fill-muted-foreground text-[8px]"
          >
            {xVal.toFixed(2)}
          </text>
        ))}

        {/* the limits of the generator pointed at: named, and drawn where they
            fall within the plot */}
        {hoveredGenerator !== null ? (
          <text
            data-testid="cpf-generators-limits-readout"
            x={PADDING_LEFT + 6}
            y={PADDING_TOP + 9}
            className="fill-foreground text-[9px]"
          >
            {`${generatorName(hoveredGenerator)}: Qmin ${formatLimit(hoveredGenerator.q_min)}, Qmax ${formatLimit(hoveredGenerator.q_max)} MVAr`}
          </text>
        ) : null}
        {hoveredGenerator !== null
          ? (['qmax', 'qmin'] as const).map((which) => {
              const limit = which === 'qmax' ? hoveredGenerator.q_max : hoveredGenerator.q_min;
              if (!finite(limit) || limit < yMin || limit > yMax) return null;
              return (
                <g key={which} data-testid={`cpf-generators-limit-${which}`}>
                  <line
                    x1={PADDING_LEFT}
                    y1={yToPx(limit)}
                    x2={PADDING_LEFT + plotW}
                    y2={yToPx(limit)}
                    stroke={busColor(generatorKey(hoveredGenerator), resolvedTheme)}
                    strokeWidth={1}
                    strokeDasharray="3,3"
                  />
                  <text
                    x={PADDING_LEFT + plotW - 2}
                    y={yToPx(limit) - 2}
                    textAnchor="end"
                    className="fill-muted-foreground text-[8px]"
                  >
                    {`${limitName(which)} ${limit.toFixed(1)}`}
                  </text>
                </g>
              );
            })
          : null}

        {drawn.map((g) => {
          const key = generatorKey(g);
          const pointsOf = (from: number, to: number) =>
            g.q
              .slice(from, to)
              .map((q, i) => {
                const x = result.lambdas[from + i];
                return x === undefined ? null : `${xToPx(x)},${yToPx(q)}`;
              })
              .filter((p): p is string => p !== null)
              .join(' ');
          const upperEnd = lowerBranch ? result.nose_idx + 1 : g.q.length;
          const stroke = busColor(key, resolvedTheme);
          const width = hovered === key ? 3 : 1.5;
          const handlers = {
            onPointerEnter: () => setHovered(key),
            onPointerLeave: () => setHovered((cur) => (cur === key ? null : cur)),
          };
          return (
            <g key={key}>
              <polyline
                points={pointsOf(0, upperEnd)}
                fill="none"
                stroke={stroke}
                strokeWidth={width}
                data-testid={`cpf-generators-line-${key}`}
                {...handlers}
              />
              {lowerBranch ? (
                <polyline
                  points={pointsOf(result.nose_idx, g.q.length)}
                  fill="none"
                  stroke={stroke}
                  strokeWidth={width}
                  strokeDasharray="4,3"
                  strokeOpacity={0.75}
                  {...handlers}
                />
              ) : null}
            </g>
          );
        })}
      </svg>

      <div
        data-testid="cpf-generators-legend"
        className={cn(
          'border-border flex max-h-24 flex-wrap items-center gap-1 overflow-y-auto',
          'border-t px-2 py-1 text-[10px]',
        )}
      >
        <span className="text-muted-foreground mr-0.5">
          Generators (click to toggle, point at one for its limits):
        </span>
        {generators.map((g) => {
          const key = generatorKey(g);
          const isVisible = visible.includes(key);
          return (
            <button
              key={key}
              type="button"
              data-testid={`cpf-generators-chip-${key}`}
              data-active={isVisible ? 'true' : 'false'}
              aria-pressed={isVisible}
              onClick={() => toggle(key)}
              onPointerEnter={() => setHovered(key)}
              onPointerLeave={() => setHovered((cur) => (cur === key ? null : cur))}
              onFocus={() => setHovered(key)}
              onBlur={() => setHovered((cur) => (cur === key ? null : cur))}
              className={cn(
                'rounded border px-1.5 py-0.5 transition-colors',
                isVisible
                  ? 'border-border bg-muted/40 text-foreground'
                  : 'border-border/40 text-muted-foreground hover:text-foreground',
                hovered === key ? 'ring-1 ring-[var(--color-ring)]' : null,
              )}
              title={`${generatorName(g)} on bus ${g.bus}: Qmin ${formatLimit(g.q_min)}, Qmax ${formatLimit(g.q_max)} MVAr`}
            >
              <span
                aria-hidden
                className="mr-1 inline-block h-2 w-2 rounded-full align-middle"
                style={{ backgroundColor: busColor(key, resolvedTheme) }}
              />
              {generatorName(g)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function formatLimit(value: number | null | undefined): string {
  return finite(value) ? value.toFixed(1) : 'none';
}

/** The generators held at a limit, with where each got there. */
function EventsTable({
  events,
  symbol,
  axis,
  noseIdx,
  full,
}: {
  events: readonly CpfLimitEvent[];
  symbol: string;
  /** The result's ``lambdas``: what a step index is on the axis. */
  axis: readonly number[];
  noseIdx: number;
  full: boolean;
}) {
  const releaseAt = (event: CpfLimitEvent): number | null => {
    const step = event.would_release_step;
    return step === null || step === undefined ? null : (axis[step] ?? null);
  };
  // The column for it is there only when a generator has something to say in it.
  const anyRelease = events.some((event) => releaseAt(event) !== null);
  return (
    <div className="border-border max-h-40 overflow-y-auto border-b">
      <table data-testid="cpf-generators-events" className="w-full border-collapse text-[11px]">
        <caption className="sr-only">Generators held at a reactive limit</caption>
        {/* Opaque: the rows scroll under a header that stays put. */}
        <thead className="bg-muted text-muted-foreground sticky top-0">
          <tr>
            <th scope="col" className="px-2 py-0.5 text-left font-medium">
              Generator
            </th>
            <th scope="col" className="px-2 py-0.5 text-left font-medium">
              Bus
            </th>
            <th scope="col" className="px-2 py-0.5 text-left font-medium">
              Held at
            </th>
            <th scope="col" className="px-2 py-0.5 text-left font-medium">
              From
            </th>
            {anyRelease ? (
              <th
                scope="col"
                className="px-2 py-0.5 text-left font-medium"
                title="Where the generator's voltage is back across its set-point: a real exciter would leave the limit there, and ANDES keeps it held"
              >
                Would leave the limit from
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {events.map((event) => {
            const release = releaseAt(event);
            return (
              <tr
                key={generatorKey(event)}
                data-testid={`cpf-generators-event-${generatorKey(event)}`}
                data-at-nose={event.at_nose ? 'true' : 'false'}
                className={cn('border-border/40 border-t', event.at_nose ? 'bg-danger/10' : null)}
              >
                <th scope="row" className="px-2 py-0.5 text-left font-mono font-normal">
                  {generatorName(event)}
                </th>
                <td className="px-2 py-0.5 font-mono">{event.bus}</td>
                <td className="px-2 py-0.5">{limitName(event.limit)}</td>
                <td className="px-2 py-0.5">
                  {event.step === 0 ? (
                    'the start (held by the power flow)'
                  ) : (
                    <>
                      <span className="font-mono tabular-nums">
                        {symbol} = {event.lam.toFixed(4)}
                      </span>
                      {full && noseIdx >= 0 && event.step > noseIdx + 1
                        ? ' on the lower branch'
                        : null}
                      {event.at_nose ? ', the nose' : null}
                    </>
                  )}
                </td>
                {anyRelease ? (
                  <td
                    className="px-2 py-0.5"
                    data-testid={`cpf-generators-release-${generatorKey(event)}`}
                  >
                    {release === null ? (
                      '—'
                    ) : (
                      <span className="font-mono tabular-nums">
                        {symbol} = {release.toFixed(4)}
                      </span>
                    )}
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
