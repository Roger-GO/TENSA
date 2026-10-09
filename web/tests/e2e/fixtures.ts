/**
 * The `test` every spec here imports: Playwright's own, with one thing added
 * that runs after each test.
 *
 * A page that loads the UI opens a session on the server. A tab that a person
 * closes gives it back as it goes (`useSessionRelease`), but a page the test
 * runner closes goes without running that, and its session idles out, three
 * minutes later by default. A run of the whole suite on a fast machine loads
 * more pages inside those three minutes than the server takes sessions
 * (`--max-sessions`), and the page that comes after the cap has no session, so
 * its test cannot open a case. Each test therefore ends the sessions its own
 * pages opened, and the suite holds only a few at a time however many specs it
 * has.
 *
 * Only what a page of the test opened is ended. A session a test opens itself
 * through `request` is the test's to end, and anything else on the server is
 * left alone, so the suite can share a server with a browser tab of your own.
 */
import { test as base } from '@playwright/test';
import type { Page } from '@playwright/test';

export { expect } from '@playwright/test';
export type { APIRequestContext, BrowserContext, Locator, Page } from '@playwright/test';

/**
 * Reload the page and wait until the case it had open is open again. A
 * reload starts a new session, and the page opens what the tab had open by
 * itself (`useReopenAfterReload`): the case file is loaded again, or the
 * system that was built from scratch is started again, and this waits for
 * the answer to that request. The edits the tab kept are replayed after it,
 * so a test that looks at the diagram next waits for it to settle as usual.
 */
export async function reloadWithCase(page: Page): Promise<void> {
  const reopened = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /^\/api\/sessions\/[^/]+\/(case|blank)$/.test(new URL(response.url()).pathname) &&
      response.ok(),
    { timeout: 90_000 },
  );
  await page.reload();
  await reopened;
}

export const test = base.extend<{ endsItsSessions: void }>({
  endsItsSessions: [
    async ({ context }, use) => {
      const opened: Promise<string | null>[] = [];
      context.on('response', (response) => {
        if (response.request().method() !== 'POST' || !response.ok()) return;
        if (new URL(response.url()).pathname !== '/api/sessions') return;
        opened.push(
          response.json().then(
            (body: { session_id?: unknown }) =>
              typeof body.session_id === 'string' ? body.session_id : null,
            () => null,
          ),
        );
      });

      await use();

      // The pages go first: one whose session is ended under it opens another.
      await Promise.all(context.pages().map((page) => page.close()));
      for (const sessionId of await Promise.all(opened)) {
        if (sessionId === null) continue;
        // Best effort: a session the server has already dropped answers 404.
        await context.request.delete(`/api/sessions/${sessionId}`).catch(() => undefined);
      }
    },
    { auto: true },
  ],
});
