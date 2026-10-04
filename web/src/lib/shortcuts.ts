/**
 * The key bindings that more than one place has to agree on: the command
 * registry (which wires them and lists them in the palette and the cheatsheet),
 * the tooltips of the buttons that do the same thing, and the handlers the
 * registry cannot own. Each value is a `react-hotkeys-hook` string whose
 * comma-separated aliases cover both platforms; `shortcutLabel` turns one into
 * the text for the user's platform.
 *
 * Browser keys: Save Page (Ctrl/Cmd+S) and Open File (Ctrl/Cmd+O) belong to the
 * browser, which acts on them unless the page calls `preventDefault`, so
 * `<GlobalShortcuts />` swallows them whether or not their command is
 * available. Ctrl/Cmd+D (bookmark) is not used for anything here for the same
 * reason.
 */
export const SHORTCUTS = {
  commandPalette: 'meta+k, ctrl+k',
  cheatsheet: '?',
  save: 'meta+s, ctrl+s',
  openCase: 'meta+o, ctrl+o',
  toggleLeftSidebar: 'meta+b, ctrl+b',
  toggleBottomDrawer: 'meta+j, ctrl+j',
  toggleRightInspector: 'meta+backslash, ctrl+backslash',
  toggleResultsView: 'meta+shift+m, ctrl+shift+m',
  searchNodes: 'meta+slash, ctrl+slash',
  toggleTheme: 'meta+shift+l, ctrl+shift+l',
  abortRun: 'escape',
} as const;
