/**
 * Close a frequency loop on a battery in a time-domain run.
 *
 *   a case with a 40 MW battery and a generator trip -> TDS tab: add a droop on
 *   the battery -> run TDS -> the page says what the droop did, the plot has the
 *   command the battery received, the TDS tab keeps the outcome beside the
 *   controller, and the Messages tab says it in words
 *
 * It drives the real UI against a real `tensa serve` (see `playwright.config.ts`):
 * the devices a controller can command come from the models the substrate loaded,
 * the droop runs in the session's worker at every sample of the run, and what it
 * did comes back on the stream's last frame. The unit tests check each of those
 * against stand-ins; this one checks that they meet in a browser.
 *
 * None of the example cases a fresh workspace is seeded with has a battery, so
 * the test first builds one over the API the UI itself uses: IEEE 14 with a
 * static generator and an `ESD1` on bus 4 and a generator that trips at 1 s,
 * saved under a name of its own.
 *
 * A second test starts where a first-time user does, on a case without a
 * battery:
 *
 *   IEEE 14 -> TDS tab: Frequency control says a battery is missing and has the
 *   button that opens its form -> the form says what stops an add (no static
 *   generator on the bus) and goes to the PV form on that bus -> the PV, then
 *   the battery on it -> the form that comes back does not offer that generator
 *   to a second battery -> the TDS tab offers the battery to a controller
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

/** Key under which the UI remembers that the first-run coach was dismissed. */
const FIRST_RUN_COACH_KEY = 'tensa:first-run-coach-v1';

const BASE_CASE = 'ieee14_full.xlsx';
const BATTERY_BUS = 4;

test.beforeEach(async ({ page }) => {
  await page.addInitScript((key) => {
    try {
      window.localStorage.setItem(key, 'dismissed');
    } catch {
      // Storage unavailable: the coach shows, which does not block the test.
    }
  }, FIRST_RUN_COACH_KEY);
});

/** A session of the test's own with `BASE_CASE` loaded. */
async function sessionWithCase(request: APIRequestContext): Promise<string> {
  const created = await request.post('/api/sessions');
  expect(created.status()).toBe(201);
  const { session_id: sessionId } = (await created.json()) as { session_id: string };
  const loaded = await request.post(`/api/sessions/${sessionId}/case`, {
    data: { primary_path: BASE_CASE },
    timeout: 90_000,
  });
  expect(loaded.status()).toBe(200);
  return sessionId;
}

/**
 * Save IEEE 14 with a 40 MW battery on bus 4 and GENROU_2 tripping at 1 s as
 * `name`, through the element builder, the disturbance route and Save.
 */
async function buildBatteryCase(request: APIRequestContext, name: string): Promise<void> {
  // The static generator the battery takes over holds the voltage the bus has
  // without it, so the battery starts with next to no reactive power to carry.
  const solved = await sessionWithCase(request);
  const pflow = await request.post(`/api/sessions/${solved}/pflow`, { data: {} });
  expect(pflow.status()).toBe(200);
  const { bus_voltages: voltages } = (await pflow.json()) as {
    bus_voltages: Record<string, number>;
  };
  await request.delete(`/api/sessions/${solved}`);

  const sessionId = await sessionWithCase(request);
  const elements = [
    {
      model: 'PV',
      params: {
        idx: 'PV_B',
        name: 'PV_B',
        bus: BATTERY_BUS,
        Sn: 100,
        Vn: 69,
        p0: 0,
        v0: voltages[String(BATTERY_BUS)],
      },
    },
    {
      model: 'ESD1',
      params: {
        idx: 'ESD1_1',
        name: 'ESD1_1',
        bus: BATTERY_BUS,
        gen: 'PV_B',
        pqflag: 1,
        pmx: 0.4,
        En: 10,
      },
    },
  ];
  for (const element of elements) {
    const added = await request.post(`/api/sessions/${sessionId}/elements`, { data: element });
    expect(added.status()).toBe(201);
  }
  const trip = await request.post(`/api/sessions/${sessionId}/disturbances`, {
    data: { disturbances: [{ kind: 'toggle', model: 'GENROU', dev_idx: 'GENROU_2', t: 1 }] },
  });
  expect(trip.status()).toBe(200);
  const saved = await request.post(`/api/sessions/${sessionId}/save`, {
    data: { filename: name, format: 'xlsx' },
  });
  expect(saved.status()).toBe(201);
  await request.delete(`/api/sessions/${sessionId}`);
}

/** Open `caseFile` from the sidebar (see load-pf-flow.spec.ts for why this retries). */
async function openCase(page: Page, caseFile: string): Promise<void> {
  await page.goto('/');
  const caseRow = page.getByTestId(`saved-cases-row-${caseFile}`).first();
  await expect(caseRow).toBeVisible();
  await expect(async () => {
    await Promise.all([
      page.waitForRequest(
        (req) => req.method() === 'POST' && new URL(req.url()).pathname.endsWith('/case'),
        { timeout: 2_000 },
      ),
      caseRow.click(),
    ]);
  }).toPass({ timeout: 30_000 });
  await expect(page.getByTestId('run-pflow-button')).toBeEnabled({ timeout: 90_000 });
}

test('frequency control: add a droop on the battery -> run TDS -> read what it did', async ({
  page,
  request,
}) => {
  const uncaughtErrors: string[] = [];
  page.on('pageerror', (error) => uncaughtErrors.push(error.message));

  const caseFile = `e2e-battery-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}.xlsx`;
  await buildBatteryCase(request, caseFile);

  await openCase(page, caseFile);

  // ---- set a droop on the battery ------------------------------------------
  await page.getByRole('tab', { name: 'Analysis' }).click();
  await page.getByTestId('analysis-sub-tab-tds').click();
  await page.getByTestId('field-tds-config-tf').fill('3');

  const editor = page.getByTestId('tds-config-controllers');
  await editor.scrollIntoViewIfNeeded();
  // The list of devices is asked for beside the list of variables; whichever
  // the session answers second is asked for again, and the button appears.
  await page.getByTestId('tds-controllers-add').click();
  const form = page.getByTestId('tds-controller-form');
  await expect(form).toBeVisible();
  // The form opens on the one device there is, sized from its limit.
  await expect(page.getByTestId('tds-controller-target')).toHaveValue(/ESD1/);
  await expect(page.getByTestId('tds-controller-target').locator('option:checked')).toHaveText(
    'ESD1_1 (bus 4, up to 40 MW)',
  );
  await expect(page.getByTestId('tds-controller-type-droop')).toBeChecked();
  await expect(page.getByTestId('field-tds-controller-gain')).toHaveValue('80');
  // A gain that is not a number is refused beside the field.
  await page.getByTestId('field-tds-controller-gain').fill('strong');
  await page.getByTestId('tds-controller-save').click();
  await expect(page.getByTestId('error-tds-controller-gain')).toHaveText('Enter a number');
  await page.getByTestId('field-tds-controller-gain').fill('80');
  await page.getByTestId('tds-controller-save').click();

  await expect(form).toHaveCount(0);
  const row = page.getByTestId('tds-controller-0');
  await expect(row).toContainText('Droop on ESD1_1');
  await expect(row).toContainText('80 MW per Hz of the system frequency beyond ±0.02 Hz');

  // ---- run it ----------------------------------------------------------------
  await page.getByTestId('run-mode-tds').click();
  await page.getByTestId('run-tds-button').click();
  await expect(page.getByTestId('tds-run-status-badge')).toContainText(/done/i, {
    timeout: 120_000,
  });

  // The page says what the droop did: the generator trips at 1 s and the first
  // sample past the dead band is the one at 1.1 s.
  const said = page.locator('[data-sonner-toast]').filter({ hasText: 'Frequency control' });
  await expect(said).toContainText('Droop on ESD1_1 acted from t = 1.1 s, peaked at');

  // The command the battery received has a chart of its own on the plot.
  const command = page.getByTestId('time-series-plot-group-dae:Pext');
  await expect(command).toBeVisible();
  await expect(command).toContainText('Pext ESD1 1');
  await expect(page.getByTestId('time-series-plot-group-dae:pIG_y')).toBeVisible();

  // ---- the outcome stays beside the controller, and in the Messages ----------
  await page.getByTestId('analysis-sub-tab-tds').click();
  await expect(page.getByTestId('tds-controller-0-result')).toContainText(
    'In the last run it acted from t = 1.1 s, peaked at',
  );

  await page.getByTestId('bottom-drawer-tab-messages').click();
  await page.getByTestId('messages-level-info').click();
  await expect(
    page.getByTestId('message-row').filter({ hasText: 'Droop on ESD1_1 acted from t = 1.1 s' }),
  ).toHaveCount(1);

  expect(uncaughtErrors).toEqual([]);
});

test('frequency control on a case without a battery: the tab leads to one, step by step', async ({
  page,
}) => {
  const uncaughtErrors: string[] = [];
  page.on('pageerror', (error) => uncaughtErrors.push(error.message));

  await openCase(page, BASE_CASE);

  // ---- the tab says what is missing, and has the way to it -------------------
  await page.getByRole('tab', { name: 'Analysis' }).click();
  await page.getByTestId('analysis-sub-tab-tds').click();
  const editor = page.getByTestId('tds-config-controllers');
  await editor.scrollIntoViewIfNeeded();
  await expect(page.getByTestId('tds-controllers-status')).toContainText(
    'This case has no device a controller can command.',
  );
  await page.getByRole('button', { name: 'Add a battery' }).click();

  // ---- the battery's form: nothing to type, but bus 4 has no generator -------
  const panel = page.getByTestId('add-element-panel');
  await expect(panel.getByTestId('element-form-ESD1')).toBeVisible();
  await expect(panel.getByTestId('field-En').locator('input')).toHaveValue('100');
  await panel.getByTestId('bus-idx-select').selectOption(String(BATTERY_BUS));
  await expect(panel.getByTestId('field-warning-bus')).toContainText(
    'Bus 4 has no PV or Slack generator.',
  );
  // An add that cannot go says which field stops it, where the page can be read.
  await panel.getByRole('button', { name: 'Add ESD1' }).click();
  await expect(panel.getByTestId('form-problems')).toHaveText(
    'Nothing was added: gen is required and empty.',
  );
  await expect(panel.getByTestId('gen-idx-select')).toBeFocused();

  // ---- the generator it needs, on that bus -----------------------------------
  await panel.getByRole('button', { name: 'Add a PV generator on bus 4' }).click();
  await expect(panel.getByTestId('element-form-PV')).toBeVisible();
  await expect(panel.getByTestId('add-element-seed-bus')).toContainText('Adding on bus BUS4');
  await expect(panel.getByTestId('bus-idx-select')).toHaveValue(String(BATTERY_BUS));
  await panel.getByRole('button', { name: 'Add PV' }).click();
  await expect(panel.getByTestId('form-problems')).toHaveText(
    'Nothing was added: Sn, Vn, p0 and v0 are required and empty.',
  );
  await expect(panel.getByTestId('field-Sn').locator('input')).toBeFocused();
  await panel.getByTestId('field-Sn').locator('input').fill('100');
  await panel.getByTestId('field-Vn').locator('input').fill('69');
  await panel.getByTestId('field-p0').locator('input').fill('0');
  await panel.getByTestId('field-v0').locator('input').fill('1.02');
  await expect(panel.getByTestId('form-problems')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Add PV' }).click();
  await expect(panel.getByTestId('add-element-success')).toContainText(
    'Added PV generator 6 on bus 4. The panel stays open for the next element',
  );

  // ---- back to the battery: the bus and its new generator are chosen ---------
  await page.getByTestId('add-element-kind').selectOption('ESD1');
  await expect(panel.getByTestId('bus-idx-select')).toHaveValue(String(BATTERY_BUS));
  // The form follows the case, which has the new generator a moment after the add.
  await expect(panel.getByTestId('gen-idx-select')).toHaveValue('6');
  await expect(panel.getByTestId('field-note-gen')).toHaveText(
    'Set to PV 6, the static generator on bus 4.',
  );
  await panel.getByRole('button', { name: 'Add ESD1' }).click();
  await expect(panel.getByTestId('add-element-success')).toContainText(
    'Added ESD1 battery ESD1_1 on bus 4.',
  );

  // ---- the form is back on the bus, whose generator is now the battery's -----
  // A second battery on PV 6 would have to share it, so the form does not open
  // with it again: another click on Add adds nothing.
  await expect(panel.getByTestId('field-idx').locator('input')).toHaveValue('ESD1_2');
  await expect(panel.getByTestId('bus-idx-select')).toHaveValue(String(BATTERY_BUS));
  await expect(panel.getByTestId('gen-idx-select')).toHaveValue('');
  await panel.getByRole('button', { name: 'Add ESD1' }).click();
  await expect(panel.getByTestId('form-problems')).toHaveText(
    'Nothing was added: gen is required and empty.',
  );
  await page.getByTestId('add-element-close').click();
  await expect(panel).toHaveCount(0);

  // ---- the tab now has a device to command -----------------------------------
  await page.getByTestId('tds-controllers-add').click();
  await expect(page.getByTestId('tds-controller-target').locator('option:checked')).toHaveText(
    'ESD1_1 (bus 4, up to 100 MW)',
  );

  expect(uncaughtErrors).toEqual([]);
});
