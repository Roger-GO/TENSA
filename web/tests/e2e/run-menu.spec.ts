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

/** What the test reads of the answer to `POST /eig`. */
interface EigReply {
  eigenvalues: { real: number; imag: number }[];
  damping_ratios: number[];
  mode_count: number;
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
  const [eigReply] = await Promise.all([
    posted(page, '/eig'),
    page.getByRole('option', { name: /Run eigenvalue analysis \(EIG\)/ }).click(),
  ]);
  await expect(page.getByTestId('command-palette')).toBeHidden();
  await expect(page.getByTestId('analyze-run-eig')).toBeVisible();
  await expect(tab).toBeFocused();
  // The plot opens on the poorly damped modes, or, for a result that has none,
  // on all of them with a sentence that says so, where the filter left it
  // empty. Which of the two it must be is read off the result the server sent
  // and not taken from what one machine computes: the eigenvalues are the
  // solver's, and a test that knows them beforehand passes on one processor
  // and fails on the next.
  const modes = (await eigReply.json()) as EigReply;
  const poorlyDamped = modes.damping_ratios.filter(
    (ratio, i) => ratio <= 0.05 && Math.abs(modes.eigenvalues[i]!.real) <= 5,
  ).length;
  const scatter = page.getByTestId('eig-scatter');
  const none = page.getByTestId('eig-scatter-none-poorly-damped');
  if (poorlyDamped === 0) {
    await expect(none).toContainText(
      `No poorly damped modes: none of the ${modes.mode_count} has a damping ratio under 0.05`,
    );
    await expect(scatter).toContainText(
      `${modes.mode_count} of ${modes.mode_count} visible (all modes)`,
    );
  } else {
    await expect(scatter).toContainText(
      `${poorlyDamped} of ${modes.mode_count} visible (filter: damping < 0.05, |Re| < 5)`,
    );
    await expect(none).toHaveCount(0);
  }
  // What no machine may make of this case: a zero eigenvalue (IEEE 14 has no
  // fixed angle reference) read as a mode that grows.
  expect(modes.eigenvalues.filter((z) => z.real > 0)).toEqual([]);
  // And the notice of the run says what the reload it calls for would cost.
  await expect(page.getByTestId('eig-info-tds-initialized')).toContainText(
    'The reload loses none of your edits',
  );

  // ---- And an entry that had nothing to run on runs once it has ---------------
  await Promise.all([posted(page, '/cpf'), runFromMenu(page, 'cpf')]);
  await expect(page.getByTestId('cpf-summary')).toContainText('max lambda', { timeout: 90_000 });
});
