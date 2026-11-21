/**
 * The admittance matrix of a case, read and downloaded from the UI.
 *
 *   open IEEE 14 -> the command palette: Admittance matrix (Ybus) -> the dialog
 *   says what the read does, and nothing is asked of the server yet -> Read
 *   matrix -> the size and the number of nonzeros are those the server sent ->
 *   a filter by a bus keeps every entry of that bus and no other -> the CSV
 *   holds every entry, at the precision the server sent -> the MATLAB file
 *   holds them too, under a name MATLAB can run
 *
 * It drives the real UI against a real `tensa serve` (see `playwright.config.ts`).
 * The numbers are read from the answer the page itself was given, not written
 * here: the spec holds the page to what ANDES built, whatever that is.
 */
import { readFile } from 'node:fs/promises';
import { test, expect } from './fixtures';
import { openCase } from './sldDrawing';

const CASE_FILE = 'ieee14_full.xlsx';

/** Key under which the UI remembers that the first-run coach was dismissed. */
const FIRST_RUN_COACH_KEY = 'tensa:first-run-coach-v1';

interface Ybus {
  n_bus: number;
  base_mva: number | null;
  bus_idx: string[];
  entries: { row: number; col: number; re: number; im: number }[];
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript((key) => {
    try {
      window.localStorage.setItem(key, 'dismissed');
    } catch {
      // Storage unavailable: the coach shows, which does not block the test.
    }
  }, FIRST_RUN_COACH_KEY);
});

test('the admittance matrix is read on request, filtered by a bus and downloaded as it was sent', async ({
  page,
}, testInfo) => {
  const ybusRequests: string[] = [];
  page.on('request', (request) => {
    if (/\/api\/sessions\/[^/]+\/ybus$/.test(new URL(request.url()).pathname)) {
      ybusRequests.push(request.url());
    }
  });

  await page.goto('/');
  await openCase(page, CASE_FILE);

  // ---- The command opens the dialog, which asks nothing yet ------------------
  await page.keyboard.press('Control+k');
  await page.getByTestId('command-palette-input').fill('admittance');
  const command = page.getByTestId('command-palette-item-export.ybus');
  await expect(command).toHaveText(/Admittance matrix \(Ybus\)/);
  await command.click();
  const dialog = page.getByRole('dialog', { name: 'Admittance matrix (Ybus)' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('ybus-setup-note')).toHaveText(
    /sets the system up .* no disturbance can be added until the case is reloaded/,
  );
  // Give a dialog that would fetch on its own the time to do it.
  await page.waitForTimeout(500);
  expect(ybusRequests).toEqual([]);

  // ---- Read matrix: what the page shows is what the server sent --------------
  const [response] = await Promise.all([
    page.waitForResponse((r) => /\/api\/sessions\/[^/]+\/ybus$/.test(new URL(r.url()).pathname)),
    dialog.getByRole('button', { name: 'Read matrix' }).click(),
  ]);
  expect(response.status()).toBe(200);
  const ybus = (await response.json()) as Ybus;
  expect(ybusRequests).toHaveLength(1);
  expect(ybus.n_bus).toBe(ybus.bus_idx.length);
  expect(ybus.entries.length).toBeGreaterThan(ybus.n_bus);

  const nnz = ybus.entries.length;
  const base = ybus.base_mva === null ? 'no system base' : `base ${ybus.base_mva} MVA`;
  await expect(dialog.getByTestId('ybus-summary')).toHaveText(
    `${ybus.n_bus} buses · ${nnz} nonzeros · ${base}`,
  );
  const rows = dialog.getByTestId(/^ybus-row-/);
  await expect(rows).toHaveCount(Math.min(nnz, 500));

  // ---- A filter by a bus keeps every entry of that bus and no other ----------
  const bus = ybus.bus_idx[0]!;
  const ofBus = ybus.entries.filter(
    (e) => ybus.bus_idx[e.row] === bus || ybus.bus_idx[e.col] === bus,
  );
  await dialog.getByRole('textbox', { name: 'Filter by bus idx' }).pressSequentially(bus);
  await expect(rows).toHaveCount(ofBus.length);
  const shown = await rows.evaluateAll((trs) =>
    trs.map((tr) => Array.from(tr.querySelectorAll('td'), (td) => td.textContent ?? '')),
  );
  for (const [rowBus, colBus] of shown) {
    expect(rowBus === bus || colBus === bus, `${rowBus} ${colBus} names bus ${bus}`).toBe(true);
  }
  // The values shown are the values sent.
  for (const e of ofBus) {
    const cells = await dialog
      .getByTestId(`ybus-row-${e.row}-${e.col}`)
      .locator('td')
      .allTextContents();
    expect(cells).toEqual([ybus.bus_idx[e.row], ybus.bus_idx[e.col], String(e.re), String(e.im)]);
  }
  await dialog.getByTestId('ybus-filter').clear();
  await expect(rows).toHaveCount(Math.min(nnz, 500));

  // ---- The CSV holds every entry, at the precision sent ----------------------
  const [csvDownload] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: 'Download CSV' }).click(),
  ]);
  expect(csvDownload.suggestedFilename()).toMatch(/^ieee14_full_ybus_[\dT-]+\.csv$/);
  const csvPath = testInfo.outputPath('ybus.csv');
  await csvDownload.saveAs(csvPath);
  const csvLines = (await readFile(csvPath, 'utf8')).trimEnd().split('\n');
  expect(csvLines[0]).toBe('row_idx,col_idx,g_pu,b_pu');
  expect(csvLines.length - 1).toBe(nnz);
  const csvRows = csvLines.slice(1).map((line) => {
    const [r, c, g, b] = line.split(',');
    return { r: r!, c: c!, g: Number(g), b: Number(b) };
  });
  // One entry off the diagonal, found in the file by its two buses.
  const offDiagonal = ybus.entries.find((e) => e.row !== e.col)!;
  const found = csvRows.filter(
    (x) => x.r === ybus.bus_idx[offDiagonal.row] && x.c === ybus.bus_idx[offDiagonal.col],
  );
  expect(found).toEqual([
    {
      r: ybus.bus_idx[offDiagonal.row],
      c: ybus.bus_idx[offDiagonal.col],
      g: offDiagonal.re,
      b: offDiagonal.im,
    },
  ]);
  // The file and the answer agree on every entry, and so on whether the matrix
  // is symmetric: computed from each, never assumed.
  const key = (r: string, c: string) => `${r}|${c}`;
  const fromCsv = new Map(csvRows.map((x) => [key(x.r, x.c), [x.g, x.b]]));
  const fromAnswer = new Map(
    ybus.entries.map((e) => [key(ybus.bus_idx[e.row]!, ybus.bus_idx[e.col]!), [e.re, e.im]]),
  );
  expect(fromCsv).toEqual(fromAnswer);
  const symmetric = (m: Map<string, number[]>) =>
    [...m].every(([k, v]) => {
      const [r, c] = k.split('|');
      const t = m.get(key(c!, r!));
      return t !== undefined && t[0] === v[0] && t[1] === v[1];
    });
  expect(symmetric(fromCsv)).toBe(symmetric(fromAnswer));

  // ---- The MATLAB file holds the matrix, under a name MATLAB can run ---------
  const [mDownload] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: 'Download MATLAB (.m)' }).click(),
  ]);
  expect(mDownload.suggestedFilename()).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,62}\.m$/);
  const mPath = testInfo.outputPath('ybus.m');
  await mDownload.saveAs(mPath);
  const mText = await readFile(mPath, 'utf8');
  expect(mText).toContain(
    `% Bus admittance matrix (Ybus), ${ybus.n_bus} x ${ybus.n_bus}, ${nnz} nonzeros`,
  );
  const triplets = mText
    .split('\n')
    .filter((line) => /^\d+ \d+ \S+ \S+$/.test(line))
    .map((line) => line.split(' ').map(Number));
  expect(triplets).toEqual(ybus.entries.map((e) => [e.row + 1, e.col + 1, e.re, e.im]));
  expect(mText).toContain(`, ${ybus.n_bus}, ${ybus.n_bus});\n`);

  // ---- Closing forgets it: the next opening says what the read does again ---
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.keyboard.press('Control+k');
  await page.getByTestId('command-palette-input').fill('ybus');
  await page.getByTestId('command-palette-item-export.ybus').click();
  await expect(page.getByTestId('ybus-setup-note')).toBeVisible();
  expect(ybusRequests).toHaveLength(1);
});
