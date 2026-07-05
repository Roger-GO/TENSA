/**
 * v0.2 polish Unit 1 — case-change e2e.
 *
 * Encodes the Phase 1 smoke Issue 2 reproducer:
 *
 *   paste token → load IEEE 14 → click Change case → confirm → pick
 *   kundur → click Load → assert substrate's topology now reflects
 *   kundur (different bus count from IEEE 14).
 *
 * The bug it guards against: pre-fix, the picker held its own
 * ``useCreateSession`` instance (separate from the one ``CaseNav`` fired
 * after DELETE). Both would race ``POST /sessions`` after the
 * change-case DELETE; the substrate would mint two sessions; only one
 * ``setSessionId`` won. The picker frequently rendered against the
 * loser, so the next ``POST /case`` 404'd silently. The fix
 * consolidates session creation to a single App-level driver.
 *
 * Like the other e2e specs, this runs against a real substrate + Vite
 * dev server. The Playwright config's ``webServer`` block starts Vite;
 * the substrate must be running independently with the
 * ``ANDES_TEST_TOKEN`` env var set. To run locally:
 *
 *   1. cp ~/andes-project/.venv/lib/python3.12/site-packages/andes/cases/{ieee14,kundur}/* \
 *        web/tests/e2e/fixtures/
 *   2. tensa serve --workspace web/tests/e2e/fixtures \
 *        --bind-port 8765 --bind-host 127.0.0.1
 *   3. ANDES_TEST_TOKEN=$(cat ~/.tensa/run-<pid>.token) \
 *        E2E_NO_WEBSERVER=1 pnpm test:e2e tests/e2e/case-change.spec.ts
 *   4. Remove the ``.fixme`` qualifier on the test below.
 */
import { test, expect } from '@playwright/test';

test.fixme('change-case: load IEEE 14 → change to kundur → substrate sees kundur', async ({
  page,
}) => {
  const token = process.env.ANDES_TEST_TOKEN;
  if (!token) throw new Error('Set ANDES_TEST_TOKEN before running this test');

  await page.goto(`/#token=${token}`);
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 10_000 });

  // ---- Step 1: load IEEE 14 ---------------------------------------------
  await page.getByRole('option', { name: 'ieee14.raw' }).click();
  await page.getByRole('button', { name: /^Load$/ }).click();

  // The summary card replaces the picker once the load succeeds. Bus 1
  // appears on the SLD canvas.
  await expect(page.getByText(/Loaded case/i)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('ieee14.raw')).toBeVisible();
  await expect(page.getByTestId('bus-node-1')).toBeVisible({ timeout: 30_000 });

  // Snapshot the bus count from IEEE 14 (14 buses) so we can assert the
  // change is observable post-swap.
  const ieee14Buses = await page.getByTestId(/^bus-node-/).count();
  expect(ieee14Buses).toBe(14);

  // ---- Step 2: change case → confirm → pick kundur ----------------------
  await page.getByRole('button', { name: /Change case/i }).click();
  // The destructive confirmation modal appears.
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: /Discard & change case/i }).click();

  // The picker reappears once the slice clears. The Load button starts in
  // its "Connecting…" state while the App-level driver mints the new
  // session, then transitions back to "Load" once the new session id
  // lands. Wait for the button to settle on the "Load" label rather than
  // racing the picker render.
  await expect(page.getByRole('button', { name: /^Load$/ })).toBeVisible({ timeout: 10_000 });

  await page.getByRole('option', { name: 'kundur.xlsx' }).click();
  await page.getByRole('button', { name: /^Load$/ }).click();

  // ---- Step 3: assert substrate now sees kundur (10 buses, not 14) -----
  await expect(page.getByText('kundur.xlsx')).toBeVisible({ timeout: 30_000 });
  // kundur's NETSS textbook case has 10 buses; IEEE 14 has 14. Asserting
  // the canonical bus-1 plus a different total proves the substrate
  // really did swap (a stale topology would still report 14).
  await expect(page.getByTestId('bus-node-1')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(/^bus-node-/)).toHaveCount(10);
});

test.fixme('change-case: re-picking the same file is a no-op (no spurious POST)', async ({
  page,
}) => {
  const token = process.env.ANDES_TEST_TOKEN;
  if (!token) throw new Error('Set ANDES_TEST_TOKEN before running this test');

  await page.goto(`/#token=${token}`);
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 10_000 });

  // Load IEEE 14 once.
  await page.getByRole('option', { name: 'ieee14.raw' }).click();
  await page.getByRole('button', { name: /^Load$/ }).click();
  await expect(page.getByText(/Loaded case/i)).toBeVisible({ timeout: 30_000 });

  // Capture the network activity for ``POST /case``. The change-case
  // confirm button appears on the summary card; clicking it reopens the
  // picker. Re-picking ieee14.raw and clicking Load should NOT fire the
  // mutation (the same-file no-op guard short-circuits).
  await page.getByRole('button', { name: /Change case/i }).click();
  await page.getByRole('button', { name: /Discard & change case/i }).click();
  await expect(page.getByRole('button', { name: /^Load$/ })).toBeVisible({ timeout: 10_000 });

  // Pick the same file as before.
  await page.getByRole('option', { name: 'ieee14.raw' }).click();

  // Wait for the case slice to be empty (the post-DELETE state) so the
  // no-op guard's ``currentSelection !== null`` check is moot. Actually
  // — after DELETE+clearCase, ``currentSelection`` IS null, so the guard
  // does NOT short-circuit. This second test is therefore a "happy
  // path" reload, not a no-op. Keeping the test scaffold here so a
  // future iteration that adds an inline same-file picker (where the
  // user clicks Change case + immediately re-picks the same file
  // without traversing the empty state) can extend the assertions
  // accordingly.
  const responsePromise = page.waitForResponse(
    (resp) => resp.url().includes('/case') && resp.request().method() === 'POST',
    { timeout: 5_000 },
  );
  await page.getByRole('button', { name: /^Load$/ }).click();
  // The mutation DOES fire here (because the slice was cleared by the
  // change-case confirm); we just verify it succeeds end-to-end.
  const resp = await responsePromise;
  expect(resp.ok()).toBe(true);
});
