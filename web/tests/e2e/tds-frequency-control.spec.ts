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
 */
import { test, expect, type APIRequestContext } from '@playwright/test';

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

test('frequency control: add a droop on the battery -> run TDS -> read what it did', async ({
  page,
  request,
}) => {
  const uncaughtErrors: string[] = [];
  page.on('pageerror', (error) => uncaughtErrors.push(error.message));

  const caseFile = `e2e-battery-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}.xlsx`;
  await buildBatteryCase(request, caseFile);

  // ---- open the case (see load-pf-flow.spec.ts for why this retries) --------
  await page.goto('/');
  const caseRow = page.getByTestId(`saved-cases-row-${caseFile}`);
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
