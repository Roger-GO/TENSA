/**
 * Unit 6 of the v2.0 polish plan — state-leakage e2e.
 *
 * Encodes the Phase 2 smoke finding documented in the plan: typing
 * into a dialog's text input must NOT contaminate other application
 * state (the canonical reproducer is the snapshot-name input
 * incidentally triggering the bus filter).
 *
 * Strategy:
 *
 *  1. Load a case so the SLD canvas is populated and the bus filter is
 *     reachable from the right dock.
 *  2. Open the Save Snapshot dialog.
 *  3. Type a name that, character by character, matches a bus the
 *     canvas would highlight if the bus filter were receiving the
 *     keystrokes (e.g., "1" — bus 1 exists in IEEE 14).
 *  4. Assert: the bus-filter input remains empty AND no bus on the
 *     canvas is highlighted.
 *  5. Hit ? while focused in the snapshot-name input → the global
 *     cheatsheet shortcut (a future Unit 10 binding) must not fire.
 *  6. Close the dialog (Esc); focus returns to the trigger.
 *
 * Like the other e2e specs in this directory, the test runs against a
 * real substrate.
 *
 * Skipped with ``test.fixme`` until they are ported. They were written
 * against the first UI (an auth-token modal and a file-picker form). The UI
 * has no authentication now and loads cases from the "Saved cases" list, so
 * the selectors below no longer match. ``load-pf-flow.spec.ts`` shows the
 * current way to open a case, and ``playwright.config.ts`` how to start the
 * substrate.
 */
import { test, expect } from '@playwright/test';

test.fixme('state-leakage: typing in snapshot-name input does not contaminate the bus filter', async ({
  page,
}) => {
  await page.goto('/');

  // Load IEEE 14 so the SLD + bus filter are present.
  await page.getByRole('option', { name: 'ieee14.raw' }).click();
  await page.getByRole('button', { name: /^Load$/ }).click();
  await expect(page.getByTestId('bus-node-1')).toBeVisible({ timeout: 30_000 });

  // Capture the bus-filter input's initial value (should be empty).
  const busFilter = page.getByTestId('bus-filter-input');
  await expect(busFilter).toHaveValue('');

  // Open Save Snapshot dialog.
  await page.getByRole('button', { name: /Save snapshot/i }).click();
  const nameInput = page.getByTestId('save-snapshot-name-input');
  await expect(nameInput).toBeVisible();
  await expect(nameInput).toBeFocused();

  // Type a name. Each character must NOT leak into the bus filter.
  // Pick characters that the bus filter would happily accept (digits +
  // alpha) so a regression would be visible: if the keystroke leaked,
  // the bus filter would update and a bus would highlight.
  await nameInput.pressSequentially('test-1', { delay: 30 });
  await expect(nameInput).toHaveValue('test-1');
  await expect(busFilter).toHaveValue('');

  // Esc closes the dialog (Radix default) and the bus filter is
  // still untouched.
  await nameInput.press('Escape');
  await expect(page.getByTestId('save-snapshot-dialog')).toHaveCount(0);
  await expect(busFilter).toHaveValue('');
});

test.fixme('state-leakage: ? key inside dialog does not open cheatsheet', async ({ page }) => {
  await page.goto('/');

  // Load IEEE 14 (any case will do; we just need the topbar's
  // snapshot button enabled).
  await page.getByRole('option', { name: 'ieee14.raw' }).click();
  await page.getByRole('button', { name: /^Load$/ }).click();
  await expect(page.getByTestId('bus-node-1')).toBeVisible({ timeout: 30_000 });

  // Open Save Snapshot dialog and press ? inside the name input.
  // The future cheatsheet (Unit 10 binding) registers '?' via
  // useHotkeys with the default `enableOnFormTags: false`, so the
  // hotkey handler does not see the keystroke while focus is in
  // the input.
  await page.getByRole('button', { name: /Save snapshot/i }).click();
  const nameInput = page.getByTestId('save-snapshot-name-input');
  await expect(nameInput).toBeFocused();

  await nameInput.press('Shift+/');
  // The literal `?` lands in the input value (typing works as
  // expected) AND the cheatsheet does NOT mount.
  await expect(nameInput).toHaveValue('?');
  await expect(page.getByTestId('keyboard-cheatsheet')).toHaveCount(0);
});

test.fixme('state-leakage: focus trap returns focus to the trigger on close', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('option', { name: 'ieee14.raw' }).click();
  await page.getByRole('button', { name: /^Load$/ }).click();
  await expect(page.getByTestId('bus-node-1')).toBeVisible({ timeout: 30_000 });

  const trigger = page.getByRole('button', { name: /Save snapshot/i });
  await trigger.focus();
  await trigger.press('Enter');
  await expect(page.getByTestId('save-snapshot-name-input')).toBeFocused();

  // Close via Esc and assert focus returns to the trigger (Radix's
  // FocusScope `restoreFocus: true` default).
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('save-snapshot-dialog')).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
