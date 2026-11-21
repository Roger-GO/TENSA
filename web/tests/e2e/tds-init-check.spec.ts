/**
 * Check initialisation through the real UI and a real `tensa serve`: the entry of
 * the run actions menu beside the Run button initialises the time-domain run of a
 * case with dynamic models without stepping it, and the dialog says what the server
 * found. The spec does not know the verdict beforehand: it reads the server's answer
 * and holds the dialog to it. A successful check holds the system as a run does, so
 * the entry is then refused with the way out beside it (Reset run), and after the
 * reset the check is offered again.
 */
import { test, expect, type Page } from './fixtures';
import { RUN_LOCK } from '../../src/lib/runLock';

const CASE_FILE = 'kundur_full.xlsx';

/** Key under which the UI remembers that the first-run coach was dismissed. */
const FIRST_RUN_COACH_KEY = 'tensa:first-run-coach-v1';

/** What the server answers `POST /sessions/{id}/tds/init` with, as far as the dialog shows it. */
interface TdsInitAnswer {
  test_ok: boolean | null;
  n_states: number;
  n_algeb: number;
  clamped: unknown[];
  residuals: unknown[];
  diagnostics_truncated: boolean;
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

async function openCaseAndRunPf(page: Page): Promise<void> {
  await page.goto('/');
  const caseRow = page.getByTestId(`saved-cases-row-${CASE_FILE}`);
  await expect(caseRow).toBeVisible();
  // A click before the background session exists does nothing: click until the case
  // request goes out.
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
  await expect(page.getByTestId(/^bus-node-\d+$/).first()).toBeVisible({ timeout: 90_000 });
  await page.getByTestId('run-pflow-button').click();
  await expect(
    page.locator('[data-sonner-toast]').filter({ hasText: /PF converged in \d+ iterations/ }),
  ).toBeVisible({ timeout: 90_000 });
}

test('Check initialisation: the server’s verdict in the dialog, the run held, Reset run, offered again', async ({
  page,
}) => {
  await openCaseAndRunPf(page);

  // The check is an entry of the menu beside the Run button, in time-domain mode.
  await page.getByTestId('run-mode-tds').click();
  const trigger = page.getByTestId('run-actions-trigger');
  await trigger.click();
  const check = page.getByTestId('tds-init-check');
  await expect(check).toHaveText('Check initialisation');
  await expect(check).not.toHaveAttribute('aria-disabled', 'true');

  const answered = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /^\/api\/sessions\/[^/]+\/tds\/init$/.test(new URL(response.url()).pathname),
    { timeout: 90_000 },
  );
  await check.click();
  const response = await answered;
  expect(response.status(), await response.text()).toBe(200);
  const answer = (await response.json()) as TdsInitAnswer;

  // The dialog says what the server found.
  const dialog = page.getByTestId('tds-init-dialog');
  await expect(dialog).toBeVisible();
  const verdict = dialog.getByTestId('tds-init-verdict');
  if (answer.test_ok === true) {
    await expect(verdict).toHaveText('Every dynamic model starts at a steady state.');
  } else if (answer.test_ok === null) {
    await expect(verdict).toContainText('The check was switched off');
  } else {
    const count = `${answer.residuals.length}${answer.diagnostics_truncated ? ' or more' : ''}`;
    await expect(verdict).toContainText(`${count} equations do not balance at the start`);
  }
  await expect(dialog.getByTestId('tds-init-counts')).toHaveText(
    `${answer.n_states} state variables, ${answer.n_algeb} algebraic variables.`,
  );
  await expect(dialog.getByTestId(/^tds-init-clamped-row-\d+$/)).toHaveCount(answer.clamped.length);
  await expect(dialog.getByTestId(/^tds-init-residual-row-\d+$/)).toHaveCount(
    answer.residuals.length,
  );
  // The check holds the system as a run does, and the dialog says so.
  await expect(dialog.getByTestId('tds-init-session-note')).toContainText(RUN_LOCK);

  // Closed, the focus goes back to the menu the check was asked from.
  await dialog.getByTestId('tds-init-close').click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  // The run carries on from the check: Run TDS is still offered.
  await expect(page.getByTestId('run-tds-button')).toHaveText('Run TDS');
  await expect(page.getByTestId('run-tds-button')).toBeEnabled();

  // A second check is refused until the case is read again, and Reset run is beside
  // the reason.
  await trigger.click();
  await expect(check).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('tds-init-check-reason')).toHaveText(
    'Reset the run first; the system is already initialised.',
  );
  const reloaded = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      /^\/api\/sessions\/[^/]+\/reload$/.test(new URL(r.url()).pathname),
    { timeout: 90_000 },
  );
  await page.getByTestId('run-actions-reset-run').click();
  expect((await reloaded).ok()).toBe(true);

  // The case is read again: the check is offered again, and Reset run is gone.
  await expect(async () => {
    await page.keyboard.press('Escape');
    await trigger.click();
    await expect(check).not.toHaveAttribute('aria-disabled', 'true', { timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  await expect(page.getByTestId('run-actions-reset-run')).toHaveCount(0);
  await expect(check).toHaveText('Check initialisation');
});
