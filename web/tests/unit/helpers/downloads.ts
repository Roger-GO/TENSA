/**
 * Catches the files an export menu hands to the browser.
 *
 * `captureDownloads()` stands in for the object-URL and anchor-click steps of
 * `downloadBlob`, so a test can click through an `<ExportMenu>` and then look at
 * the Blob and the file name that came out. Call `restore()` in `afterEach`.
 * `exportAs` clicks the menu's trigger and one of its formats; `readBlob`
 * reads a captured Blob as text (jsdom's Blob has no `.text()`).
 */
import { screen } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { vi } from 'vitest';

export interface DownloadCapture {
  readonly blobs: Blob[];
  readonly filenames: string[];
  restore: () => void;
}

export function captureDownloads(): DownloadCapture {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const blobs: Blob[] = [];
  const filenames: string[] = [];
  URL.createObjectURL = ((blob: Blob) => {
    blobs.push(blob);
    return 'blob:captured';
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    filenames.push(this.download);
  });
  return {
    blobs,
    filenames,
    restore: () => {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
      click.mockRestore();
    },
  };
}

/** Open the export menu and pick a format. `scope` narrows the lookup when several menus are mounted. */
export async function exportAs(
  user: UserEvent,
  format: 'csv' | 'png' | 'mat',
  scope?: HTMLElement,
): Promise<void> {
  const trigger = scope
    ? scope.querySelector<HTMLElement>('[data-testid="export-menu-trigger"]')
    : screen.getByTestId('export-menu-trigger');
  if (trigger === null) throw new Error('no export menu inside the given scope');
  await user.click(trigger);
  await user.click(await screen.findByTestId(`export-menu-${format}`));
}

export async function readBlob(blob: Blob): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsText(blob, 'utf-8');
  });
}
