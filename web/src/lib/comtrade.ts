/**
 * Preparing a run for ``POST /comtrade``, which writes it as an IEEE C37.111
 * record. Pure, so what is sent (which columns, in which unit, under which
 * names) is testable without a server.
 *
 * The record itself is written by the substrate (``tensa.core.comtrade``); this
 * module only decides what to send. The values go as the run streamed them,
 * like the CSV of the same menu: voltage and speed per unit, angles in radians,
 * power in MW and MVAr, each channel saying which.
 */
import type { ComtradeExportRequest } from '@/api/types';
import { ExportRefusedError } from '@/components/export/exportError';
import { slugify } from '@/components/export/exportFilename';
import { runLabel, shortRunId } from '@/lib/runLabel';
import { parseColumnName } from '@/store/plot';
import type { RunRecord } from '@/store/runs';

/** The substrate's bound on one export, channels times samples (``api/schemas.py``). */
export const MAX_COMTRADE_VALUES = 5_000_000;

/**
 * The frequency a record states when the run does not carry its case's own:
 * ANDES's default, which a case that sets none runs at.
 */
const DEFAULT_FREQUENCY_HZ = 60;

/** The longest name the substrate takes for the record's files. */
const MAX_NAME_CHARS = 64;

/**
 * The longest station, device or channel name the route takes. The record
 * holds 64 characters of each, so nothing that is written is lost by the cut.
 */
const MAX_TEXT_CHARS = 200;

/**
 * The unit a streamed column holds its values in, or ``undefined`` for an ANDES
 * variable recorded by name: the run does not carry ANDES's unit for it, and
 * the substrate writes such a channel with the unit ``NONE``.
 */
export function simulatedUnit(columnName: string): string | undefined {
  const parsed = parseColumnName(columnName);
  if (parsed === null) return undefined;
  switch (parsed.group) {
    case 'bus_v':
      return parsed.field === 'a' ? 'rad' : 'pu';
    case 'gen_state':
      return parsed.field === 'delta' ? 'rad' : 'pu';
    case 'gen_power':
      return parsed.field === 'Qe' ? 'MVAr' : 'MW';
    case 'line_flow':
    case 'load_pq':
      return parsed.field === 'q' ? 'MVAr' : 'MW';
    case 'dae':
      return undefined;
  }
}

/**
 * What the record's two files are called: the run's case and the start of its
 * id (``ieee14_1a2b3c4d``), within the rule the substrate holds a file name to
 * (letters, digits, ``.``, ``_`` and ``-``, a letter or digit first, 64 at most).
 */
export function comtradeFileName(run: Pick<RunRecord, 'runId' | 'caseName'>): string {
  const id = slugify(shortRunId(run.runId), 'run');
  const room = MAX_NAME_CHARS - id.length - 1;
  const stem = slugify(run.caseName ?? '', 'tds')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, room);
  return `${stem.length > 0 ? stem : 'tds'}_${id}`;
}

/** A time of this machine's clock as ISO 8601 without a zone, to the millisecond. */
function localIso(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return (
    `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

/**
 * The request that writes the columns ``names`` of ``run`` as one record, or
 * ``null`` when there is nothing to write (no rows yet, none of the names is a
 * column of the run).
 *
 * The record's station is the case the run was computed on and its device the
 * run's label ("TENSA TDS #3 - fault bus 7"), so a record says which study it is
 * from. Its date is when the run started, by this machine's clock: the format
 * has no time zone to say otherwise.
 *
 * Throws ``ExportRefusedError`` when the columns hold more values than one
 * export takes, before anything is sent.
 */
export function comtradeRequest(
  run: RunRecord,
  names: readonly string[],
): ComtradeExportRequest | null {
  const samples = run.seqCount;
  const wanted = new Set(names);
  // The run's own order, whatever order the names were given in.
  const columns = run.columnNames.filter(
    (name) => wanted.has(name) && run.columns[name] !== undefined,
  );
  if (samples === 0 || columns.length === 0) return null;

  const held = columns.length * samples;
  if (held > MAX_COMTRADE_VALUES) {
    const count = (n: number) => n.toLocaleString('en-US');
    throw new ExportRefusedError(
      `${count(columns.length)} variables of ${count(samples)} samples are ${count(held)} values, ` +
        `and one COMTRADE export takes at most ${count(MAX_COMTRADE_VALUES)}. ` +
        'Plot the variables you need and use Export plot, which exports only what is plotted.',
    );
  }

  const freqHz = run.bases?.freqHz;
  return {
    t: Array.from(run.t.subarray(0, samples)),
    channels: columns.map((name) => {
      const unit = simulatedUnit(name);
      return {
        name: name.slice(0, MAX_TEXT_CHARS),
        ...(unit === undefined ? {} : { unit }),
        // A value that is not a number leaves as ``null`` (JSON has no NaN),
        // which is how the route takes a missing value.
        values: Array.from(run.columns[name]!.subarray(0, samples)),
      };
    }),
    name: comtradeFileName(run),
    station: (run.caseName ?? '').slice(0, MAX_TEXT_CHARS),
    device: `TENSA ${runLabel(run)}`.slice(0, MAX_TEXT_CHARS),
    frequency_hz:
      typeof freqHz === 'number' && Number.isFinite(freqHz) && freqHz > 0
        ? freqHz
        : DEFAULT_FREQUENCY_HZ,
    ...(Number.isFinite(run.startedAt) ? { start_time: localIso(run.startedAt) } : {}),
  };
}
