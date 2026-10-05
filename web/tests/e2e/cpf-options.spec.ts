/**
 * Continuation power flow with its options.
 *
 *   load IEEE 14 -> power flow -> nose curve without limits -> tick Q limits ->
 *   the form says the power flow broke them and solves it again -> the nose is
 *   where the slack generator runs out of reactive power -> the full curve ->
 *   a custom direction -> a run that uses up its steps, and the button that
 *   runs it again with more
 *
 * It drives the real UI against a real `tensa serve` (see `playwright.config.ts`):
 * the curves are what ANDES traced, with the limits enforced by the server. The
 * unit tests check the form, the chart and the generator panel against stand-ins
 * and the server's own tests check the numbers; this one checks that the options
 * reach the routine the way a user sets them, and that what comes back says what
 * was run.
 */
import { test, expect, type Page } from '@playwright/test';

const CASE_FILE = 'ieee14_full.xlsx';

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

/** Run CPF from the form and wait for the reply to its request. */
async function runCpf(page: Page): Promise<Record<string, unknown>> {
  const [response] = await Promise.all([
    page.waitForResponse(
      (reply) =>
        reply.request().method() === 'POST' && new URL(reply.url()).pathname.endsWith('/cpf'),
      { timeout: 90_000 },
    ),
    page.getByTestId('analyze-run-cpf').click(),
  ]);
  expect(response.status()).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

/** The lambda the summary line beside the Run button gives as the largest reached. */
async function maxLambda(page: Page): Promise<number> {
  const text = await page.getByTestId('cpf-summary').innerText();
  const match = /max lambda = ([\d.]+)/.exec(text);
  expect(match, text).not.toBeNull();
  return Number(match![1]);
}

test('CPF: limits change the nose, and the result says which generator it is due to', async ({
  page,
}) => {
  const uncaughtErrors: string[] = [];
  page.on('pageerror', (error) => uncaughtErrors.push(error.message));

  await page.goto('/');
  await openCase(page, CASE_FILE);

  await page.getByTestId('run-pflow-button').click();
  await expect(
    page.locator('[data-sonner-toast]').filter({ hasText: /PF converged in \d+ iterations/ }),
  ).toHaveCount(1, { timeout: 90_000 });

  await page.getByRole('tab', { name: 'Analysis' }).click();
  await page.getByTestId('analysis-sub-tab-cpf').click();

  // ---- without limits: the load grows more than threefold --------------------
  await runCpf(page);
  expect(await maxLambda(page)).toBeGreaterThan(3);
  await expect(page.getByTestId('cpf-run-caption')).toContainText('Q limits not enforced');
  await expect(page.getByTestId('cpf-generators-summary')).toContainText(
    'Q limits were not enforced: generators are free to go past them.',
  );
  // Five generators: four PV and the slack, each with a line and a chip.
  await expect(page.getByTestId('cpf-generators')).toContainText('5 generators');
  await expect(page.getByTestId('cpf-generators-chip-Slack-1')).toBeVisible();

  // ---- with limits: the form says the power flow has to be solved with them --
  await page.getByTestId('cpf-config-enforce-q-limits').check();
  const note = page.getByTestId('cpf-config-q-limits-pflow-note');
  await expect(note).toContainText('The last power flow left generators 2, 4 past a Q limit.');
  await page.getByTestId('cpf-config-q-limits-run-pflow').click();
  await expect(
    page.locator('[data-sonner-toast]').filter({ hasText: 'Q limits enforced' }),
  ).toHaveCount(1, { timeout: 90_000 });
  await expect(note).toHaveCount(0);

  const enforced = await runCpf(page);
  expect(enforced.q_limits_enforced).toBe(true);
  // Half again the base load: where the slack, the last generator with any
  // reactive power to give, runs out of it too.
  const nose = await maxLambda(page);
  expect(nose).toBeGreaterThan(0.5);
  expect(nose).toBeLessThan(0.53);
  await expect(page.getByTestId('cpf-run-caption')).toContainText('Q limits enforced');
  await expect(page.getByTestId('cpf-generators-summary')).toContainText(
    '4 generators held at a limit from the start, 1 more reached one along the path',
  );
  await expect(page.getByTestId('cpf-generators-nose')).toContainText(
    'The nose is where Slack 1 (bus 1) reached Qmax',
  );
  await expect(page.getByTestId('cpf-generators-event-Slack-1')).toContainText('the nose');
  await expect(page.getByTestId('cpf-limit-marker-Slack-1')).toBeAttached();
  // No bus ran away: the curve ends at the switch.
  const voltages = enforced.voltages_per_bus as Record<string, number[]>;
  expect(Math.max(...Object.values(voltages).flat())).toBeLessThan(1.2);

  // ---- the full curve ---------------------------------------------------------
  await page.getByTestId('cpf-config-lower-branch').check();
  const full = await runCpf(page);
  expect(full.stop_at).toBe('full');
  expect(full.complete).toBe(true);
  const lambdas = full.lambdas as number[];
  expect(lambdas[lambdas.length - 1]).toBeCloseTo(0, 6);
  await expect(page.getByTestId('cpf-run-caption')).toContainText('full curve');
  await expect(page.getByTestId('cpf-curve-lower-14')).toBeAttached();
  // The nose has not moved.
  expect(await maxLambda(page)).toBeCloseTo(nose, 3);
  await page.getByTestId('cpf-config-lower-branch').uncheck();

  // ---- a custom direction -------------------------------------------------------
  await page.getByTestId('cpf-config-direction-custom').check();
  // Nothing typed yet: the run is refused in the form, with the reason.
  await page.getByTestId('analyze-run-cpf').click();
  await expect(page.getByTestId('cpf-config-error')).toContainText(
    'A custom direction needs an increase on at least one load or generator.',
  );
  // 10 MW and 3 MVAr more on bus 14's load for each unit of lambda, met by generator 2.
  await page.getByTestId('cpf-direction-load-PQ_11-p').fill('10');
  await page.getByTestId('cpf-direction-load-PQ_11-q').fill('3');
  await page.getByTestId('cpf-direction-gen-2-p').fill('10');
  // The editor adds up what one unit of lambda is, beside what the case has.
  await expect(page.getByTestId('cpf-direction-total')).toContainText(
    'One unit of λ changes the loads by +10 MW and +3 MVAr (base case: 223.7 MW',
  );
  const custom = await runCpf(page);
  expect(custom.direction).toBe('custom');
  await expect(page.getByTestId('cpf-run-caption')).toContainText(
    'Custom · λ = 1 is the custom increase as given',
  );
  // Lambda counts tens of megawatts on one bus now, not multiples of the system load.
  const customNose = await maxLambda(page);
  expect(customNose).toBeGreaterThan(1);
  await expect(page.getByTestId('cpf-step-limit-note')).toHaveCount(0);

  // ---- a run that uses up its steps ---------------------------------------------
  // Eight steps do not get this direction to its nose. The form says so by the
  // Run button and offers four times as many, which do.
  await page.getByTestId('cpf-config-advanced-toggle').click();
  await page.getByTestId('field-cpf-config-max-iter').fill('8');
  const cutShort = await runCpf(page);
  expect(cutShort.truncated).toBe(true);
  const stepNote = page.getByTestId('cpf-step-limit-note');
  await expect(stepNote).toContainText('The run used all of its 8 steps and stopped at λ = ');
  await expect(stepNote).toContainText('before it reached the nose');
  await expect(page.getByTestId('cpf-truncated-banner')).toContainText(
    'raise Max steps (under Advanced in the options above) and run again',
  );
  const [again] = await Promise.all([
    page.waitForResponse(
      (reply) =>
        reply.request().method() === 'POST' && new URL(reply.url()).pathname.endsWith('/cpf'),
      { timeout: 90_000 },
    ),
    page.getByRole('button', { name: 'Run again with up to 32 steps' }).click(),
  ]);
  expect(again.request().postDataJSON()).toMatchObject({ direction: 'custom', max_iter: 32 });
  const whole = (await again.json()) as Record<string, unknown>;
  expect(whole.truncated).toBe(false);
  await expect(stepNote).toHaveCount(0);
  await expect(page.getByTestId('field-cpf-config-max-iter')).toHaveValue('32');
  // The same nose as the run that had steps to spare.
  expect(await maxLambda(page)).toBeCloseTo(customNose, 3);

  expect(uncaughtErrors, uncaughtErrors.join('\n')).toEqual([]);
});
