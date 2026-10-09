/**
 * The entries of the Run menu run.
 *
 *   open IEEE 14 -> the Run menu and the palette list the eigenvalue
 *   analysis greyed out, with "run a power flow first" under it -> Run > Run
 *   continuation power flow (CPF) -> it says why it was not started, with the
 *   CPF tab open -> Run > Run power flow (PF) -> the power flow is solved, and
 *   the notice says the run has fixed the system and where the result was kept
 *   -> the palette: Run eigenvalue analysis (EIG) -> the EIG tab opens with its
 *   result on all modes (none is poorly damped), says what Reload case costs,
 *   and the keyboard focus is back where it was -> Run > Run continuation
 *   power flow (CPF) -> the curve
 *
 * It drives the real UI against a real `tensa serve` (see `playwright.config.ts`).
 * The entries used to choose the routine of the Run button and run nothing; the
 * unit tests hold the command and each Run button apart, and this holds that a
 * press of the entry reaches the server.
 */
import { test, expect, type Page } from './fixtures';
import { openCase } from './sldDrawing';

const CASE_FILE = 'ieee14_full.xlsx';
const FIRST_RUN_COACH_KEY = 'tensa:first-run-coach-v1';

const toast = (page: Page, text: string | RegExp) =>
  page.locator('[data-sonner-toast]').filter({ hasText: text });

/** Press the entry `id` of the Run menu. */
async function runFromMenu(page: Page, id: string): Promise<void> {
  await page.getByTestId('topbar-menu-run-trigger').click();
  await page.getByTestId(`topbar-menu-run-${id}`).click();
}

const posted = (page: Page, path: string) =>
  page.waitForResponse(
    (reply) => reply.request().method() === 'POST' && new URL(reply.url()).pathname.endsWith(path),
    { timeout: 90_000 },
  );

test.beforeEach(async ({ page }) => {
  await page.addInitScript((key) => {
    try {
      window.localStorage.setItem(key, 'dismissed');
    } catch {
      // Storage unavailable: the coach shows, which does not block the test.
    }
  }, FIRST_RUN_COACH_KEY);
});

test('an entry of the Run menu starts its routine, or says why it cannot', async ({ page }) => {
  await page.goto('/');
  await openCase(page, CASE_FILE);

  // ---- The names say what a press does --------------------------------------
  await page.getByTestId('topbar-menu-run-trigger').click();
  const menu = page.getByTestId('topbar-menu-run-content');
  await expect(menu).toContainText('Run power flow (PF)');
  await expect(menu).toContainText('Run time-domain simulation (TDS)');
  await expect(menu).toContainText('Parameter sweep…');
  // ---- The eigenvalue analysis is listed before it can run, with the reason --
  // It used to be left out until a power flow had converged.
  const eig = page.getByTestId('topbar-menu-run-eig');
  await expect(eig).toContainText('Run eigenvalue analysis (EIG)');
  await expect(eig).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('topbar-menu-run-eig-reason')).toHaveText(
    'Run a power flow first: eigenvalues are of the solved operating point.',
  );
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  // The palette says the same, where a search for it found nothing.
  await page.keyboard.press('Control+k');
  await page.getByTestId('command-palette-input').fill('eigenvalue');
  const row = page.getByTestId('command-palette-item-run.eig');
  await expect(row).toHaveAttribute('aria-disabled', 'true');
  await expect(row).toContainText('Run a power flow first');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('command-palette')).toBeHidden();

  // ---- One that cannot run yet says why, where it is run ---------------------
  await runFromMenu(page, 'cpf');
  await expect(toast(page, 'Continuation power flow (CPF) was not started')).toContainText(
    'Run PFlow first',
  );
  await expect(page.getByTestId('analyze-run-cpf')).toBeVisible();
  await expect(page.locator('[data-testid^="bus-voltage-"]')).toHaveCount(0);

  // ---- Run power flow (PF) solves it -----------------------------------------
  await Promise.all([posted(page, '/pflow'), runFromMenu(page, 'pflow')]);
  await expect(page.locator('[data-testid^="bus-voltage-"]').first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(toast(page, /PF converged in \d+ iterations/)).toContainText(
    'Kept as PF #1 under Analysis > Compare. The run has fixed the system',
  );

  // ---- The palette runs too, and gives the keyboard focus back ---------------
  const tab = page.getByRole('tab', { name: 'Components' });
  await tab.focus();
  await page.keyboard.press('Control+k');
  await page.getByTestId('command-palette-input').fill('Run eigenvalue');
  await Promise.all([
    posted(page, '/eig'),
    page.getByRole('option', { name: /Run eigenvalue analysis \(EIG\)/ }).click(),
  ]);
  await expect(page.getByTestId('command-palette')).toBeHidden();
  await expect(page.getByTestId('analyze-run-eig')).toBeVisible();
  await expect(tab).toBeFocused();
  // IEEE 14 has no poorly damped mode: the plot opens on all of them and says
  // so, where the filter left it empty; and the notice of the run says what
  // the reload it calls for would cost.
  await expect(page.getByTestId('eig-scatter-none-poorly-damped')).toContainText(
    /^No poorly damped modes: none of the \d+ has a damping ratio under 0\.05/,
  );
  await expect(page.getByTestId('eig-scatter')).toContainText(/(\d+) of \1 visible \(all modes\)/);
  await expect(page.getByTestId('eig-info-tds-initialized')).toContainText(
    'The reload loses none of your edits',
  );

  // ---- And an entry that had nothing to run on runs once it has ---------------
  await Promise.all([posted(page, '/cpf'), runFromMenu(page, 'cpf')]);
  await expect(page.getByTestId('cpf-summary')).toContainText('max lambda', { timeout: 90_000 });
});
