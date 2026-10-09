/**
 * Whether the page is on its way out: reloaded, navigated away from, or its
 * tab closed.
 *
 * A browser ends the requests of a page that leaves, and each of them fails in
 * the page as a lost connection would, with the page still running for a
 * moment. Nothing of that is an answer to anything. What the tab keeps for the
 * page that comes next (the open case in `store/reloadedCase.ts`, its edits in
 * `store/editJournal.ts`, the drafts of a system built from scratch) is settled
 * by then, and code that would drop or cut it over a failed request asks here
 * first. Without that, a reload pressed while the case of an earlier reload was
 * still loading left the next page with no case to open.
 *
 * `pagehide` is the last a page hears before it goes, and Chromium fails the
 * requests after it. A browser that fails them before it is why a request
 * that got no answer changes nothing of what the tab keeps either
 * (`useReopenAfterReload`, `replayEditsInto`). A page the browser keeps for
 * Back and Forward (`persisted`) is not leaving: it may be shown again as it
 * was, which `pageshow` says.
 */
let leaving = false;

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) leaving = true;
  });
  window.addEventListener('pageshow', () => {
    leaving = false;
  });
}

/** True from the `pagehide` of a page that is not kept for Back and Forward. */
export function pageIsLeaving(): boolean {
  return leaving;
}
