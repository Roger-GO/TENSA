/**
 * Another tool's result laid over a time-domain run in the plot.
 *
 *   load Kundur -> run a time-domain simulation -> Export plot -> Import
 *   external result... -> choose a TSAT export -> Import -> keep one of its two
 *   series -> Add to plot -> its chip `tsat: column 1` is in the legend row, the
 *   charts hold the series, the cursor readout reads it at its own samples and
 *   finds no value in its gap, and the run's CSV is the same as before -> remove
 *   it from its chip -> the charts no longer hold it -> a file the server refuses
 *   shows the server's own words
 *
 * It drives the real UI against a real `tensa serve` (see `playwright.config.ts`).
 * The workbook is written here, in the layout the server's reader takes for a
 * TSAT export (`server/src/tensa/core/external_results.py`): a header row, the
 * 6 rows ANDES skips after it, then time and the signals in columns.
 */
import { readFile } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import { test, expect, type Page } from './fixtures';

const CASE_FILE = 'kundur_full.xlsx';
const TF_SECONDS = 2;

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

/** A .zip of `files`, stored without compression, as an .xlsx package is one. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8');
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** The column letter of a 0-based column index (the sheets here are narrow). */
function columnLetter(index: number): string {
  return String.fromCharCode('A'.charCodeAt(0) + index);
}

/** A one-sheet .xlsx workbook of `rows`: text as inline strings, null as an empty cell. */
function workbook(rows: readonly (readonly (string | number | null)[])[]): Buffer {
  const sheetRows = rows
    .map((row, r) => {
      const cells = row
        .map((value, c) => {
          const ref = `${columnLetter(c)}${r + 1}`;
          if (value === null) return '';
          if (typeof value === 'number') return `<c r="${ref}"><v>${value}</v></c>`;
          return `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');
  const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const rels = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const pkg = 'http://schemas.openxmlformats.org/package/2006/relationships';
  return zip({
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '</Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      `<Relationships xmlns="${pkg}">` +
      `<Relationship Id="rId1" Type="${rels}/officeDocument" Target="xl/workbook.xml"/>` +
      '</Relationships>',
    'xl/workbook.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      `<workbook xmlns="${main}" xmlns:r="${rels}">` +
      '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      `<Relationships xmlns="${pkg}">` +
      `<Relationship Id="rId1" Type="${rels}/worksheet" Target="worksheets/sheet1.xml"/>` +
      '</Relationships>',
    'xl/worksheets/sheet1.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      `<worksheet xmlns="${main}"><sheetData>${sheetRows}</sheetData></worksheet>`,
  });
}

/**
 * A TSAT channel export: the header, the 6 rows the reader skips, then time and
 * two signals. Column 1 has no value at 1.0 s (a gap), and its last sample is
 * past the end of the run, where the plot does not draw it.
 */
const TSAT_EXPORT = workbook([
  ['Time', 'Channel 1', 'Channel 2'],
  ...Array.from({ length: 6 }, (_, i) => [`meta ${i}`, 'pu', 'Hz']),
  [0, 1.0, 60],
  [0.5, 1.01, 60.1],
  [1.0, null, 60.2],
  [1.5, 0.99, 60.1],
  [2.0, 1.0, 60],
  [5.0, 2.0, 61],
]);

/** The labels of every series the charts of the plot draw, from uPlot's own legends. */
async function plottedLabels(page: Page): Promise<string[]> {
  return await page
    .getByTestId('time-series-plot')
    .locator('.u-legend .u-series .u-label')
    .allTextContents();
}

/** Export the plotted series as CSV and read the file the browser is handed. */
async function exportCsv(page: Page, path: string): Promise<string> {
  await page.getByRole('button', { name: 'Export plot', exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-menu-csv').click(),
  ]);
  await download.saveAs(path);
  return await readFile(path, 'utf8');
}

/** Open the import dialog from the plot's menu. */
async function openImportDialog(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Export plot', exact: true }).click();
  const entry = page.getByTestId('export-menu-import-external');
  await expect(entry).toContainText('Import external result');
  await entry.click();
  await expect(page.getByTestId('external-results-dialog')).toBeVisible();
}

/** Put cursor A at `t` by typing the time, and read the row of `label` in the readout. */
async function valueAtCursor(page: Page, t: number, label: string): Promise<string> {
  const box = page.getByTestId('cursor-readout-a');
  await box.fill(String(t));
  await box.press('Enter');
  const row = page.getByTestId('cursor-readout-table').locator('tr', { hasText: label }).first();
  await expect(row).toBeVisible();
  // The second cell is the value at A.
  return (await row.locator('td').nth(1).textContent()) ?? '';
}

test('an imported TSAT export is drawn over the run, read at its own samples, and removed', async ({
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
  const before = await plottedLabels(page);
  expect(before.length).toBeGreaterThan(1);
  expect(before.some((label) => label.startsWith('tsat:'))).toBe(false);
  const csvBefore = await exportCsv(page, testInfo.outputPath('before.csv'));

  // ---- import ------------------------------------------------------------------
  await openImportDialog(page);
  await expect(page.getByTestId('external-results-source-tsat')).toBeChecked();
  await page.getByTestId('external-results-file').setInputFiles({
    name: 'tsat-export.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: TSAT_EXPORT,
  });
  const [request, response] = await Promise.all([
    page.waitForRequest((r) => new URL(r.url()).pathname === '/api/external-results'),
    page.waitForResponse((r) => new URL(r.url()).pathname === '/api/external-results'),
    page.getByTestId('external-results-import').click(),
  ]);
  // The file's bytes are the whole body, sent as they are, with the source named.
  expect(request.method()).toBe('POST');
  expect(new URL(request.url()).searchParams.get('source')).toBe('tsat');
  expect(request.headers()['content-type']).toBe('application/octet-stream');
  expect(response.status()).toBe(200);
  // The server read the workbook written above (the browser does not hand a
  // File body to the request's record, so it is checked by what was read).
  const read = (await response.json()) as {
    source: string;
    samples: number;
    series: { name: string; t: number[]; y: (number | null)[] }[];
  };
  expect(read.source).toBe('tsat');
  expect(read.samples).toBe(6);
  expect(read.series.map((s) => s.name)).toEqual(['column 1', 'column 2']);
  expect(read.series[0]!.y).toEqual([1.0, 1.01, null, 0.99, 1.0, 2.0]);

  await expect(
    page.getByText('The file holds 6 samples in 2 series. Pick the series to plot.'),
  ).toBeVisible();
  await expect(page.getByTestId('external-results-series-column 1')).toBeChecked();
  // Keep column 1 only.
  await page.getByTestId('external-results-series-column 2').uncheck();
  await page.getByTestId('external-results-add').click();
  await expect(page.getByTestId('external-results-dialog')).toBeHidden();

  // ---- drawn ----------------------------------------------------------------------
  const chip = page.getByTestId('external-trace-chip-tsat:column 1');
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('tsat: column 1');
  await expect(
    page.getByTestId('time-series-plot-legend').getByTestId('external-trace-chip-tsat:column 1'),
  ).toBeVisible();
  await expect(page.getByTestId('external-trace-chip-tsat:column 2')).toHaveCount(0);
  await expect
    .poll(async () => (await plottedLabels(page)).filter((l) => l === 'tsat: column 1').length)
    .toBeGreaterThan(0);
  const withTrace = await plottedLabels(page);
  expect(withTrace.filter((l) => l.startsWith('tsat:')).every((l) => l === 'tsat: column 1')).toBe(
    true,
  );
  // Every series of the run is still drawn.
  expect(withTrace.filter((l) => !l.startsWith('tsat:'))).toEqual(before);

  // The readout reads the series at its own samples, and finds nothing in its gap.
  await page.getByTestId('plot-cursors-toggle').click();
  expect(await valueAtCursor(page, 0.5, 'tsat: column 1')).toBe('1.01');
  expect(await valueAtCursor(page, 1.25, 'tsat: column 1')).toBe('–');
  expect(await valueAtCursor(page, 1.75, 'tsat: column 1')).toBe('0.995');
  await page.getByTestId('plot-cursors-clear').click();
  await page.getByTestId('plot-cursors-toggle').click();

  // The run's own export does not take the imported series in.
  const csvWith = await exportCsv(page, testInfo.outputPath('with.csv'));
  expect(csvWith).toBe(csvBefore);

  // ---- removed --------------------------------------------------------------------
  await page.getByRole('button', { name: 'Remove tsat: column 1' }).click();
  await expect(chip).toHaveCount(0);
  await expect.poll(() => plottedLabels(page)).toEqual(before);

  // ---- refused --------------------------------------------------------------------
  await openImportDialog(page);
  await page.getByTestId('external-results-file').setInputFiles({
    name: 'not-a-workbook.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from('time,value\n0,1\n', 'utf8'),
  });
  const [refusal] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === '/api/external-results'),
    page.getByTestId('external-results-import').click(),
  ]);
  expect(refusal.status()).toBe(422);
  const detail = ((await refusal.json()) as { detail: string }).detail;
  expect(detail).toContain('not an .xlsx workbook');
  const alert = page.getByTestId('external-results-error');
  await expect(alert).toHaveAttribute('role', 'alert');
  await expect(alert).toHaveText(detail);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('external-results-dialog')).toBeHidden();
  await expect(page.getByTestId('time-series-plot-legend')).toHaveCount(0);

  expect(uncaughtErrors).toEqual([]);
});
