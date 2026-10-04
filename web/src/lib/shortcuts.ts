/**
 * The key bindings that more than one place has to agree on: the command
 * registry (which wires them and lists them in the palette and the cheatsheet)
 * and the tooltips of the buttons that do the same thing. Each value is a
 * `react-hotkeys-hook` string whose comma-separated aliases cover both platforms;
 * `shortcutLabel` turns one into the text for the user's platform.
 *
 * Ctrl/Cmd+D (bookmark) is not used for anything here: the browser keeps it.
 */
export const SHORTCUTS = {
  commandPalette: 'meta+k, ctrl+k',
  cheatsheet: '?',
  toggleLeftSidebar: 'meta+b, ctrl+b',
  toggleBottomDrawer: 'meta+j, ctrl+j',
  toggleRightInspector: 'meta+backslash, ctrl+backslash',
  toggleResultsView: 'meta+shift+m, ctrl+shift+m',
  searchNodes: 'meta+slash, ctrl+slash',
  toggleTheme: 'meta+shift+l, ctrl+shift+l',
} as const;
