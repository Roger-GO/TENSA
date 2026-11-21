/**
 * The parameter sweep of the eigenvalue tab draws the root locus the server
 * computed.
 *
 *   open Kundur -> run the power flow -> Analysis > EIG -> Parameter sweep ->
 *   the damping D of a GENROU from 0 to 2 in 3 points -> Run sweep -> the page
 *   sent the three values and draws a dot for every eigenvalue the server
 *   answered, a table row per value with its unstable modes counted from the
 *   answer, and a legend that names the parameter and its range -> 201 points
 *   are refused in the form and nothing is sent -> a parameter the server does
 *   not sweep (a PQ load's Ppf, which the picker lists because a disturbance
 *   can alter it) is refused with the server's own reason
 *
 * It drives the real UI against a real `tensa serve` (see `playwright.config.ts`).
 * What the page must show is read off the answer to the page's own request and
 * not known beforehand: the eigenvalues are the solver's, and a test that knows
 * them passes on one processor and fails on the next. A sweep point costs a
 * read, a setup, a power flow and an eigenvalue analysis of the case, so the
 * sweep is three points and the test has time for them.
 */
import { test, expect, type Page } from './fixtures';
import { openCase } from './sldDrawing';

const CASE_FILE = 'kundur_full.xlsx';
const FIRST_RUN_COACH_KEY = 'tensa:first-run-coach-v1';

/** What the test reads of the answer to `POST /eig/sweep`. */
interface SweepReply {
  model: string;
  idx: string;
  param: string;
  points: {
    value: number;
    eigenvalues: { real: number; imag: number }[];
    damping_ratios: number[];
  }[];
  mode_count: number;
}

const isSweep = (url: string, method: string) =>
  method === 'POST' && new URL(url).pathname.endsWith('/eig/sweep');

test.beforeEach(async ({ page }) => {
  await page.addInitScript((key) => {
    try {
      window.localStorage.setItem(key, 'dismissed');
    } catch {
      // Storage unavailable: the coach shows, which does not block the test.
    }
  }, FIRST_RUN_COACH_KEY);
});

/** The values of a `<select>` other than its empty prompt. */
async function choices(page: Page, testId: string): Promise<string[]> {
  return await page
    .getByTestId(testId)
    .locator('option')
    .evaluateAll((options) =>
      options.map((o) => (o as HTMLOptionElement).value).filter((v) => v !== ''),
    );
}

test('a parameter sweep draws the root locus the server answered', async ({ page }) => {
  test.setTimeout(240_000);
  const sent: string[] = [];
  page.on('request', (request) => {
    if (isSweep(request.url(), request.method())) sent.push(request.postData() ?? '');
  });

  await page.goto('/');
  await openCase(page, CASE_FILE);

  // ---- a power flow, then the eigenvalue tab ---------------------------------
  await Promise.all([
    page.waitForResponse(
      (reply) =>
        reply.request().method() === 'POST' && new URL(reply.url()).pathname.endsWith('/pflow'),
      { timeout: 90_000 },
    ),
    page.getByTestId('run-pflow-button').click(),
  ]);
  await page.getByTestId('bottom-drawer-tab-analysis').click();
  await page.getByTestId('analysis-sub-tab-eig').click();
  const sweep = page.getByTestId('eig-sweep');
  await sweep.getByText('Parameter sweep', { exact: true }).click();
  await expect(page.getByTestId('eig-sweep-empty')).toHaveText(
    'Run a sweep to see the root locus.',
  );
  await expect(page.getByTestId('analyze-run-eig-sweep')).toBeEnabled({ timeout: 30_000 });

  // ---- the form: a GENROU's damping, three points ----------------------------
  await expect.poll(() => choices(page, 'eig-sweep-model')).toContain('GENROU');
  await page.getByTestId('eig-sweep-model').selectOption('GENROU');
  const machines = await choices(page, 'eig-sweep-idx');
  expect(machines.length).toBeGreaterThan(0);
  const machine = machines[0]!;
  await page.getByTestId('eig-sweep-idx').selectOption(machine);
  await expect.poll(() => choices(page, 'eig-sweep-param')).toContain('D');
  await page.getByTestId('eig-sweep-param').selectOption('D');
  await page.getByTestId('field-eig-sweep-start').fill('0');
  await page.getByTestId('field-eig-sweep-end').fill('2');

  // ---- 201 points are refused in the form, and nothing goes out --------------
  await page.getByTestId('field-eig-sweep-points').fill('201');
  await expect(page.getByTestId('error-eig-sweep-points')).toHaveText(
    'Enter a whole number of points from 1 to 200.',
  );
  await page.getByTestId('analyze-run-eig-sweep').click();
  expect(sent).toEqual([]);

  // ---- three points: the page sends them and draws what came back ------------
  await page.getByTestId('field-eig-sweep-points').fill('3');
  await expect(page.getByTestId('error-eig-sweep-points')).toHaveCount(0);
  const [reply] = await Promise.all([
    page.waitForResponse((r) => isSweep(r.url(), r.request().method()), { timeout: 180_000 }),
    page.getByTestId('analyze-run-eig-sweep').click(),
  ]);
  expect(reply.status()).toBe(200);
  expect(JSON.parse(sent[0]!)).toEqual({
    model: 'GENROU',
    idx: machine,
    param: 'D',
    values: [0, 1, 2],
  });
  const answer = (await reply.json()) as SweepReply;
  expect(answer.points.map((p) => p.value)).toEqual([0, 1, 2]);
  expect(answer.mode_count).toBeGreaterThan(0);

  const locus = page.getByTestId('eig-sweep-locus');
  await expect(locus).toBeVisible();
  const total = answer.points.reduce((n, p) => n + p.eigenvalues.length, 0);
  await expect(locus.locator('[data-testid^="eig-sweep-locus-point-"]')).toHaveCount(total);
  // Every dot is inside the plot: the view holds the farthest eigenvalue.
  const outside = await locus.locator('[data-testid^="eig-sweep-locus-point-"]').evaluateAll(
    (dots) =>
      dots.filter((d) => {
        const cx = Number(d.getAttribute('cx'));
        const cy = Number(d.getAttribute('cy'));
        return cx < 28 || cx > 292 || cy < 28 || cy > 212;
      }).length,
  );
  expect(outside).toBe(0);

  await expect(page.getByTestId('eig-sweep-legend-name')).toHaveText(`D of GENROU ${machine}`);
  await expect(page.getByTestId('eig-sweep-legend-min')).toHaveText('0');
  await expect(page.getByTestId('eig-sweep-legend-max')).toHaveText('2');

  const rows = page.getByTestId('eig-sweep-table').locator('tbody tr');
  await expect(rows).toHaveCount(answer.points.length);
  for (const [i, point] of answer.points.entries()) {
    const unstable = point.eigenvalues.filter((z) => z.real > 0).length;
    await expect(rows.nth(i).locator('[data-col="value"]')).toHaveText(String(point.value));
    await expect(rows.nth(i).locator('[data-col="unstable"]')).toHaveText(String(unstable));
  }
  expect(sent).toHaveLength(1);

  // ---- a parameter the server does not sweep: its reason is shown ------------
  // A PQ load's Ppf is a service a disturbance can alter, which the picker lists
  // with the parameters; the sweep takes parameters only.
  await page.getByTestId('eig-sweep-model').selectOption('PQ');
  const loads = await choices(page, 'eig-sweep-idx');
  await page.getByTestId('eig-sweep-idx').selectOption(loads[0]!);
  await expect.poll(() => choices(page, 'eig-sweep-param')).toContain('Ppf');
  await page.getByTestId('eig-sweep-param').selectOption('Ppf');
  const [refusal] = await Promise.all([
    page.waitForResponse((r) => isSweep(r.url(), r.request().method()), { timeout: 60_000 }),
    page.getByTestId('analyze-run-eig-sweep').click(),
  ]);
  expect(refusal.status()).toBe(404);
  const problem = (await refusal.json()) as { detail: string };
  expect(problem.detail).toContain('Ppf');
  await expect(page.getByTestId('eig-sweep-error')).toContainText(problem.detail);
  // The last result stays on screen under the refusal.
  await expect(locus.locator('[data-testid^="eig-sweep-locus-point-"]')).toHaveCount(total);
});
