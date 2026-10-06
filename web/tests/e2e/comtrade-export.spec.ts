/**
 * A time-domain run saved as a COMTRADE record.
 *
 *   load Kundur -> run a time-domain simulation -> Export run data -> COMTRADE
 *   -> the .zip the browser was handed holds a .cfg and a .dat of one name ->
 *   read as IEEE C37.111 lays them out, they hold the run -> Export plot ->
 *   COMTRADE -> a record of the plotted series only -> reload the page -> pin
 *   the run the browser kept -> Export plot -> COMTRADE -> the same record,
 *   still named for its case, with no case open
 *
 * It drives the real UI against a real `tensa serve` (see `playwright.config.ts`)
 * and reads the file the browser was handed. The unit tests check what the
 * browser sends against a stand-in server, and the server's tests check the
 * record against signals made up for them; this one checks that what ANDES
 * streamed reaches the record through both.
 *
 * Kundur's own case file trips a line at 2 s, so the voltages move and the run's
 * samples are not evenly spaced, without a fault being added.
 */
import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { test, expect, type Page } from './fixtures';

const CASE_FILE = 'kundur_full.xlsx';
const TF_SECONDS = 4;

/** Key under which the UI remembers that the first-run coach was dismissed. */
const FIRST_RUN_COACH_KEY = 'tensa:first-run-coach-v1';

test.beforeEach(async ({ page }) => {
  await page.addInitScript((key) => {
    try {
      window.localStorage.setItem(key, 'dismissed');
    } catch {
      // Storage unavailable: the coach shows, which does not block the test.
    }
  }, FIRST_RUN_COACH_KEY);
});

/** Open a case from the saved-cases list (see load-pf-flow.spec.ts for why this retries). */
async function openCase(page: Page, caseFile: string): Promise<void> {
  const caseRow = page.getByTestId(`saved-cases-row-${caseFile}`);
  await expect(caseRow).toBeVisible();
  await expect(async () => {
    await Promise.all([
      page.waitForRequest(
        (request) =>
          request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/case'),
        { timeout: 2_000 },
      ),
      caseRow.click(),
    ]);
  }).toPass({ timeout: 30_000 });
  await expect(page.getByTestId('run-pflow-button')).toBeEnabled({ timeout: 90_000 });
}

/**
 * Open the run history. At the width the tests run at, the History button is in
 * the top bar's More menu (see `topBarLayout.ts`).
 */
async function openHistory(page: Page): Promise<void> {
  await page.getByTestId('topbar-menu-more-trigger').click();
  await page.getByTestId('topbar-menu-more-navigation.history').click();
  await expect(page.getByTestId('history-drawer')).toBeVisible();
}

/** How many runs the browser's own storage holds, read behind the UI's back. */
async function runsInBrowserStorage(page: Page): Promise<number> {
  return await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const open = indexedDB.open('tensa-results');
        open.onerror = () => resolve(-1);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('run-data')) {
            db.close();
            resolve(0);
            return;
          }
          const count = db.transaction(['run-data'], 'readonly').objectStore('run-data').count();
          count.onsuccess = () => {
            db.close();
            resolve(count.result);
          };
          count.onerror = () => {
            db.close();
            resolve(-1);
          };
        };
      }),
  );
}

/** The files of a .zip, by name. Reads the central directory, as an unzip tool does. */
function unzip(archive: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end, 'the download is a .zip').toBeGreaterThanOrEqual(0);
  const count = archive.readUInt16LE(end + 10);
  let entry = archive.readUInt32LE(end + 16);
  for (let i = 0; i < count; i += 1) {
    expect(archive.readUInt32LE(entry)).toBe(0x02014b50);
    const method = archive.readUInt16LE(entry + 10);
    const size = archive.readUInt32LE(entry + 20);
    const nameLength = archive.readUInt16LE(entry + 28);
    const extraLength = archive.readUInt16LE(entry + 30);
    const commentLength = archive.readUInt16LE(entry + 32);
    const local = archive.readUInt32LE(entry + 42);
    const name = archive.toString('utf8', entry + 46, entry + 46 + nameLength);
    // The local header repeats the name and has an extra field of its own.
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const stored = archive.subarray(start, start + size);
    files.set(name, method === 0 ? Buffer.from(stored) : inflateRawSync(stored));
    entry += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

interface Channel {
  name: string;
  unit: string;
  values: number[];
}

interface ComtradeRecord {
  name: string;
  header: string;
  channels: Channel[];
  /** Seconds from the first sample. */
  t: number[];
  nrates: number;
  dateLines: string[];
}

/** A record read as IEEE C37.111-1999 lays out its two files. */
function readRecord(archive: Buffer): ComtradeRecord {
  const files = unzip(archive);
  const names = [...files.keys()].sort();
  expect(names).toHaveLength(2);
  const [cfgName, datName] = names as [string, string];
  expect(cfgName).toMatch(/\.cfg$/);
  expect(datName).toBe(cfgName.replace(/\.cfg$/, '.dat'));

  const cfgText = files.get(cfgName)!.toString('latin1');
  expect(cfgText.endsWith('\r\n')).toBe(true);
  const cfg = cfgText.slice(0, -2).split('\r\n');
  const [total, analog, status] = cfg[1]!.split(',') as [string, string, string];
  const channelCount = Number(analog.replace(/A$/, ''));
  expect(Number(total)).toBe(channelCount);
  expect(status).toBe('0D');
  const rest = cfg.slice(2 + channelCount);
  const nrates = Number(rest[1]);
  const [, endSample] = rest[2]!.split(',');
  expect(rest.slice(5)).toEqual(['ASCII', '1']);

  const datText = files.get(datName)!.toString('latin1');
  // CR LF after the last line, then the end-of-file mark the standard asks for.
  expect(datText.endsWith('\r\n\x1a')).toBe(true);
  const rows = datText
    .slice(0, -3)
    .split('\r\n')
    .map((line) => line.split(',').map(Number));
  expect(rows).toHaveLength(Number(endSample));
  rows.forEach((row, index) => {
    expect(row[0]).toBe(index + 1);
    expect(row).toHaveLength(2 + channelCount);
  });

  const channels = cfg.slice(2, 2 + channelCount).map((line, column) => {
    const fields = line.split(',');
    expect(fields).toHaveLength(13);
    expect(Number(fields[0])).toBe(column + 1);
    const a = Number(fields[5]);
    const b = Number(fields[6]);
    return {
      name: fields[1]!,
      unit: fields[4]!,
      values: rows.map((row) => a * row[2 + column]! + b),
    };
  });
  return {
    name: cfgName.replace(/\.cfg$/, ''),
    header: cfg[0]!,
    channels,
    t: rows.map((row) => row[1]! * 1e-6),
    nrates,
    dateLines: rest.slice(3, 5),
  };
}

/** Pick COMTRADE in the export menu behind `trigger` and read the record the browser is handed. */
async function exportComtrade(
  page: Page,
  trigger: string,
  path: string,
): Promise<{ record: ComtradeRecord; fileName: string }> {
  await page.getByRole('button', { name: trigger, exact: true }).click();
  const item = page.getByTestId('export-menu-comtrade');
  await expect(item).toHaveText('COMTRADE (.zip)');
  const [download] = await Promise.all([page.waitForEvent('download'), item.click()]);
  await download.saveAs(path);
  return { record: readRecord(await readFile(path)), fileName: download.suggestedFilename() };
}

test('a time-domain run is saved as a COMTRADE record that holds the run', async ({
  page,
}, testInfo) => {
  const uncaughtErrors: string[] = [];
  page.on('pageerror', (error) => uncaughtErrors.push(error.message));

  await page.goto('/');
  await openCase(page, CASE_FILE);
  await page.getByRole('tab', { name: 'Analysis' }).click();
  await page.getByTestId('analysis-sub-tab-tds').click();
  await page.locator('#tds-config-tf').fill(String(TF_SECONDS));
  await page.getByTestId('run-mode-tds').click();
  await page.getByTestId('run-tds-button').click();
  await expect(page.getByTestId('tds-run-status-badge')).toContainText(/done/i, {
    timeout: 120_000,
  });
  await expect(page.getByTestId('time-series-plot-group-bus_v')).toBeVisible();

  // ---- every column of the run -------------------------------------------------
  const whole = await exportComtrade(page, 'Export run data', testInfo.outputPath('run.zip'));
  await expect(
    page
      .locator('[data-sonner-toast]')
      .filter({ hasText: /Exported kundur_full_\w+_scrub-comtrade_/ })
      .first(),
  ).toBeVisible();
  expect(whole.fileName).toMatch(
    /^kundur_full_[0-9a-f]{8}_scrub-comtrade_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.zip$/,
  );
  const run = whole.record;
  // The two files are named for the case and the run, and the record says so too.
  expect(run.name).toMatch(/^kundur_full_[0-9a-f]{8}$/);
  expect(whole.fileName.startsWith(run.name)).toBe(true);
  expect(run.header).toBe('kundur_full,TENSA TDS #1,1999');
  for (const line of run.dateLines) {
    expect(line).toMatch(/^\d{2}\/\d{2}\/\d{4},\d{2}:\d{2}:\d{2}\.\d{6}$/);
  }

  // Kundur: ten buses and four machines, each with two streamed columns.
  const units = new Map(run.channels.map((c) => [c.name, c.unit]));
  expect(run.channels).toHaveLength(28);
  expect(units.get('Bus_1_v')).toBe('pu');
  expect(units.get('Bus_1_a')).toBe('rad');
  expect([...units.values()].every((unit) => unit === 'pu' || unit === 'rad')).toBe(true);
  expect([...units.keys()].filter((name) => /^Gen_.+_omega$/.test(name))).toHaveLength(4);

  // The time stamps run from the first sample to the end of the run, in order.
  // The last one is the time the run was asked to reach: its last step is sent
  // as it is, not averaged with the steps before it.
  expect(run.t[0]).toBe(0);
  expect(run.t.every((t, i) => i === 0 || t >= run.t[i - 1]!)).toBe(true);
  expect(run.t.at(-1)!).toBeCloseTo(TF_SECONDS, 6);

  // The values are the run's: voltages near 1 pu that move when the line trips
  // at 2 s, and speeds that leave 1 pu after it.
  const voltages = run.channels.filter((c) => /^Bus_.+_v$/.test(c.name));
  expect(voltages).toHaveLength(10);
  for (const voltage of voltages) {
    expect(Math.min(...voltage.values)).toBeGreaterThan(0.8);
    expect(Math.max(...voltage.values)).toBeLessThan(1.2);
  }
  const before = run.t.findLastIndex((t) => t < 1.9);
  const speed = run.channels.find((c) => /^Gen_.+_omega$/.test(c.name))!;
  expect(Math.abs(speed.values[before]! - 1)).toBeLessThan(1e-6);
  expect(Math.max(...speed.values.map((value) => Math.abs(value - 1)))).toBeGreaterThan(1e-5);
  expect(
    voltages.some((v) => Math.abs(v.values.at(-1)! - v.values[before]!) > 1e-4),
    'no bus voltage moved after the line tripped',
  ).toBe(true);

  // ---- the plotted series only ---------------------------------------------------
  const plotted = await exportComtrade(page, 'Export plot', testInfo.outputPath('plot.zip'));
  expect(plotted.fileName).toMatch(/^kundur_full_[0-9a-f]{8}_time-series-comtrade_.*\.zip$/);
  const shown = plotted.record.channels;
  expect(shown.length).toBeGreaterThan(0);
  expect(shown.length).toBeLessThan(run.channels.length);
  for (const channel of shown) {
    const same = run.channels.find((c) => c.name === channel.name);
    expect(same, `${channel.name} is a column of the run`).toBeDefined();
    expect(channel.values).toEqual(same!.values);
  }
  expect(plotted.record.t).toEqual(run.t);

  // ---- the run the browser kept, after a reload and with no case open --------------
  const runId = await page.getByTestId('time-series-plot').getAttribute('data-run-id');
  expect(runId).toBeTruthy();
  await expect.poll(() => runsInBrowserStorage(page)).toBe(1);
  await page.reload();
  await expect(page.getByTestId('run-pflow-button')).toBeDisabled();
  await openHistory(page);
  await page.getByTestId(`history-run-row-pin-${runId}`).click();
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Analysis' }).click();
  await page.getByTestId('analysis-sub-tab-plot').click();
  await expect(page.getByTestId('time-series-plot')).toHaveAttribute('data-run-id', runId!);

  const kept = await exportComtrade(page, 'Export plot', testInfo.outputPath('kept.zip'));
  // The session that computed the run is gone and no case is open: the record
  // is written from what the browser kept, and still says which case it is of.
  expect(kept.record.header).toBe('kundur_full,TENSA TDS #1,1999');
  expect(kept.record.name).toBe(run.name);
  expect(kept.fileName).toMatch(/^kundur_full_[0-9a-f]{8}_time-series-comtrade_.*\.zip$/);
  expect(kept.record.dateLines).toEqual(run.dateLines);
  expect(kept.record.channels).toEqual(plotted.record.channels);

  expect(uncaughtErrors).toEqual([]);
});
