/**
 * Where the toasts are drawn: below the top bar, above a dialog and under an
 * open top bar menu. jsdom lays nothing out, so what is checked here is what
 * the toaster is told; `tests/e2e/top-bar-fit.spec.ts` checks the outcome in a
 * browser.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { toast as sonnerToast } from 'sonner';

import { Toaster } from '@/components/ui/Toaster';
import { TOAST_TOP_OFFSET_PX, TOAST_Z_INDEX, TOP_BAR_MENU_Z_INDEX } from '@/components/ui/layers';
import { toast } from '@/lib/toast';

/** `z-50`, the layer of the dialogs, popovers and tooltips (`components/ui`). */
const OVERLAY_Z_INDEX = 50;
/** `h-11`, the height of the top bar (`components/shell/TopBar.tsx`), in px. */
const TOP_BAR_HEIGHT_PX = 44;

afterEach(() => {
  act(() => {
    sonnerToast.dismiss();
  });
  cleanup();
});

describe('<Toaster />', () => {
  it('draws the toasts above a dialog and under an open top bar menu', async () => {
    expect(TOAST_Z_INDEX).toBeGreaterThan(OVERLAY_Z_INDEX);
    expect(TOP_BAR_MENU_Z_INDEX).toBeGreaterThan(TOAST_Z_INDEX);

    render(<Toaster />);
    act(() => {
      toast.success('Saved');
    });

    const list = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-sonner-toaster]');
      if (found === null) throw new Error('no toast list yet');
      return found;
    });
    expect(list.style.zIndex).toBe(String(TOAST_Z_INDEX));
  });

  it('starts the toasts below the top bar', async () => {
    expect(TOAST_TOP_OFFSET_PX).toBeGreaterThan(TOP_BAR_HEIGHT_PX);

    render(<Toaster />);
    act(() => {
      toast.info('Loaded');
    });

    const list = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-sonner-toaster]');
      if (found === null) throw new Error('no toast list yet');
      return found;
    });
    expect(list.dataset.yPosition).toBe('top');
    expect(list.style.getPropertyValue('--offset-top')).toBe(`${TOAST_TOP_OFFSET_PX}px`);
    expect(list.style.getPropertyValue('--mobile-offset-top')).toBe(`${TOAST_TOP_OFFSET_PX}px`);
  });
});
