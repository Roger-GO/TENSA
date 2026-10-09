/**
 * A page knows that it is going away from its `pagehide`, which is what the
 * code that would drop what the tab keeps over a failed request asks about.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { pageIsLeaving } from '@/lib/pageLeaving';

function pageHide(persisted: boolean): void {
  const event = new Event('pagehide');
  Object.defineProperty(event, 'persisted', { value: persisted });
  window.dispatchEvent(event);
}

afterEach(() => {
  window.dispatchEvent(new Event('pageshow'));
});

describe('pageIsLeaving', () => {
  it('is false while the page is shown', () => {
    expect(pageIsLeaving()).toBe(false);
  });

  it('is true once the page is hidden for good', () => {
    pageHide(false);
    expect(pageIsLeaving()).toBe(true);
  });

  it('stays false for a page the browser keeps for Back and Forward', () => {
    pageHide(true);
    expect(pageIsLeaving()).toBe(false);
  });

  it('is false again for a page that is shown again', () => {
    pageHide(false);
    window.dispatchEvent(new Event('pageshow'));
    expect(pageIsLeaving()).toBe(false);
  });
});
