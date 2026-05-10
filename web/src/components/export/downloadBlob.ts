/**
 * Browser download trigger shared by every Export menu path.
 *
 * Kept in its own module (separate from `ExportMenu.tsx`) so the
 * `react-refresh/only-export-components` rule lets the component file
 * export only the React component itself. The helper has no React
 * dependency and is safe to import from any export-format file or test.
 */

/**
 * Trigger a browser download for a Blob via the standard
 * `URL.createObjectURL` → temporary anchor → revoke pattern.
 *
 * Throws when `URL.createObjectURL` itself rejects (some browsers gate
 * blob URLs behind a quota or extension policy). The Export menu
 * catches that throw and surfaces an inline failure message.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  // Let `URL.createObjectURL` throw propagate — the caller handles it
  // as the "Export failed" path.
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    // Anchors must be in the DOM for `.click()` to dispatch a
    // download in Firefox. Clean up immediately afterwards.
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } finally {
    // Revoke on the next tick so Safari has time to start the download
    // before the URL is invalidated (the established workaround).
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
