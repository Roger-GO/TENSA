/**
 * Build-from-scratch e2e test. Encodes this critical path:
 *
 *   New system → add Bus 1, 2, 3 → add Lines 1-2, 2-3
 *     → add Slack on Bus 1, PV on Bus 2, PQ load on Bus 3
 *     → Run PF → assert overlays + 3-row table.
 *
 * Like `load-pf-flow.spec.ts`, it runs against a real substrate. The workspace
 * can be empty, since the test never loads a file.
 *
 * Skipped with `test.fixme()` until it is ported. It was written against the
 * first UI (an auth-token modal and an add-element panel with its own
 * selectors). The UI has no authentication now, so the first steps and the
 * selectors below need updating. `playwright.config.ts` says how to start the
 * substrate.
 */
import { test, expect, type Page } from './fixtures';

async function fillField(page: Page, fieldName: string, value: string | number): Promise<void> {
  const field = page.getByTestId(`field-${fieldName}`);
  const input = field.locator('input').first();
  await input.fill(String(value));
}

async function pickBus(page: Page, fieldName: string, busIdx: string): Promise<void> {
  const field = page.getByTestId(`field-${fieldName}`);
  await field.locator('select').first().selectOption(busIdx);
}

async function addElement(
  page: Page,
  kind: string,
  params: Record<string, string | number>,
): Promise<void> {
  // Open the Add panel (idempotent — clicking on an open panel does
  // nothing visible).
  await page.getByTestId('add-element-button').click();
  await page.getByTestId('add-element-kind').selectOption(kind);
  // Wait for the form to render the kind's fields.
  await expect(page.getByTestId(`element-form-${kind}`)).toBeVisible();
  for (const [name, value] of Object.entries(params)) {
    if (name === 'bus' || name === 'bus1' || name === 'bus2') {
      await pickBus(page, name, String(value));
    } else {
      await fillField(page, name, value);
    }
  }
  await page.getByRole('button', { name: new RegExp(`^add ${kind}$`, 'i') }).click();
  // Panel closes on success.
  await expect(page.getByTestId('add-element-panel')).toHaveCount(0, {
    timeout: 10_000,
  });
}

test.fixme('flagship: build a 3-bus system from scratch + run PF', async ({ page }) => {
  await page.goto('/');

  // Click "+ New system".
  await page.getByTestId('new-system-button').click();
  // Empty-state CTA appears.
  await expect(page.getByTestId('sld-empty-system')).toBeVisible({ timeout: 10_000 });

  // Bus 1, 2, 3.
  for (const idx of ['1', '2', '3']) {
    await addElement(page, 'Bus', {
      idx,
      name: `BUS${idx}`,
      Vn: 100,
    });
    await expect(page.getByTestId(`bus-node-${idx}`)).toBeVisible();
  }

  // Lines 1-2 and 2-3.
  await addElement(page, 'Line', {
    idx: 'L12',
    name: 'L12',
    bus1: '1',
    bus2: '2',
    r: 0.01,
    x: 0.05,
  });
  await addElement(page, 'Line', {
    idx: 'L23',
    name: 'L23',
    bus1: '2',
    bus2: '3',
    r: 0.01,
    x: 0.05,
  });

  // Slack on bus 1, PV on bus 2, PQ load on bus 3.
  await addElement(page, 'Slack', {
    idx: 'SLACK1',
    name: 'SLACK1',
    bus: '1',
    Sn: 100,
    Vn: 100,
    v0: 1.0,
  });
  await addElement(page, 'PV', {
    idx: 'PV2',
    name: 'PV2',
    bus: '2',
    Sn: 100,
    Vn: 100,
    p0: 0.5,
    v0: 1.0,
  });
  await addElement(page, 'PQ', {
    idx: 'L3',
    name: 'L3',
    bus: '3',
    Vn: 100,
    p0: 0.4,
    q0: 0.1,
  });

  // Run PF.
  await page.getByTestId('run-pflow-button').click();
  await expect(page.getByTestId('pflow-success-toast')).toBeVisible({ timeout: 30_000 });

  // SLD now shows 3 buses + 2 generators + 1 load with overlays.
  for (const idx of ['1', '2', '3']) {
    await expect(page.getByTestId(`bus-node-${idx}`)).toBeVisible();
    await expect(page.getByTestId(`bus-voltage-${idx}`)).toBeVisible();
  }
  await expect(page.getByTestId('generator-node-SLACK1')).toBeVisible();
  await expect(page.getByTestId('generator-node-PV2')).toBeVisible();
  await expect(page.getByTestId('load-node-L3')).toBeVisible();

  // Results table: Buses tab shows 3 rows.
  const buses = page.getByTestId(/^results-row-bus-/);
  await expect(buses).toHaveCount(3);
});
