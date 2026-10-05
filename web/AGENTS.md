# Web AGENTS guidance

Conventions for the React frontend at `web/`. Keeps the codebase consistent across hand-edits and AI-generated changes.

## Form-input contract

**Use `<Input>` from `@/components/ui/Input` for any controlled text or number input.** Raw `<input>` is fine for checkboxes, radios, and file pickers.

```tsx
import { Input } from '@/components/ui/Input';

<Input value={state} onChange={setState} placeholder="…" />;
```

### Why

The native `<input>` controlled-component pattern has two non-obvious failure modes that `<Input>` papers over:

1. **IME composition (CJK, accented chars).** Calling parent `onChange` mid-composition produces partial text + lost characters. `<Input>` defers `onChange` until `compositionend` fires.
2. **Programmatic value setters in tests.** Setting `el.value = 'x'` + dispatching a synthetic `input` event bypasses React's onChange unless the test uses the React-friendly setter dance (`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(...)`). `<Input>` forwards correctly via React's controlled-component contract; tests using `userEvent.type()` or `locator.pressSequentially()` Just Work.

### Never use `defaultValue` for stateful inputs

`defaultValue` decouples the input from React state and breaks form validation, programmatic resets, and snapshot/restore flows. Always use `value + onChange`.

## Toast policy (Unit 3)

**Three rules:**

| Surface                                                                     | Use                                                                |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Form-validation errors ("Required", "Must be > tf")                         | Inline `role="alert"` next to the field. NEVER a toast.            |
| Transient action results (export complete, snapshot saved, sweep cancelled) | `toast.success/.error/.warning/.info` from `@/lib/toast`           |
| Recovery state transitions (session restored, substrate reconnected)        | `toast.success` / `toast.error` with action button (Reload, Retry) |

```tsx
import { toast } from '@/lib/toast';

// Success after a button click that triggers a server action
toast.success('Bundle exported as andes-bundle-abc.zip');

// Error with retry CTA
toast.error('Snapshot save failed: disk full', {
  action: { label: 'Retry', onClick: () => save() },
});
```

`<Toaster />` is mounted once at AppShell root. The lib (`sonner`) is lazy — DOM only renders after first toast fires.

## Keyboard shortcuts (Unit 6)

**Use `useHotkeys` from `@/lib/useHotkeys`** for any window-level keyboard binding. Defaults: `enableOnFormTags: false` + `enableOnContentEditable: false`, so shortcuts auto-skip when an editable element has focus.

```tsx
import { useHotkeys } from '@/lib/useHotkeys';

useHotkeys('?', () => openCheatsheet(), []);

// Special case: ⌘K palette is global — enable inside form tags
useHotkeys('meta+k', () => openCommandPalette(), [], {
  enableOnFormTags: ['INPUT', 'TEXTAREA'],
});
```

For ad-hoc skip checks: `isEditableTarget(element)` / `isEditableActiveElement()`.

**Never** call `window.addEventListener("keydown", ...)` directly — bypasses the editable-element skip and contributes to state-leakage bugs.

**Bindings live in the command registry** (`@/lib/commands`): give a command a `shortcut` and `<GlobalShortcuts />` binds it, the palette and the cheatsheet list it. A binding that something else has to repeat (a button's tooltip, a handler the registry cannot own) is a constant in `@/lib/shortcuts`; write tooltips with `withShortcut(text, SHORTCUTS.x)` from `@/lib/shortcutFormatter`, which names the key of the user's platform (Ctrl+B, or ⌘B on macOS), never a hard-coded `⌘`.

- **Browser keys.** Ctrl/Cmd+S (Save Page) and Ctrl/Cmd+O (Open File) are bound in `<GlobalShortcuts />` whether or not their command is available, so a press never falls through to the browser, whatever has focus: they pass `enableOnFormTags: true`, because the lib also takes an element with a role such as radio, slider or menuitem for a form tag, which a list of tag names does not cover. Do not bind Ctrl/Cmd+D, T, W or N, which the browser keeps.
- **Esc and other layers.** A global binding does not fire for a keydown that something else already used (`event.defaultPrevented`), which is how Esc stays free to close dialogs, menus and popovers (Radix prevents the default when it dismisses) without also running a command bound to Esc. Pass `ignoreEventWhen` yourself if you register such a key outside the registry.

## Run-button readiness (Unit 4)

**All Run buttons (PF / TDS / EIG / CPF / SE / Sweep) consume `useRunReadiness(routine)`** from `@/lib/useRunReadiness`. Returns `{ ready, disabledReason, recovery, recoveryHint }`.

```tsx
import { useRunReadiness } from '@/lib/useRunReadiness';

const { ready, disabledReason, recovery } = useRunReadiness('eig');
```

Disabled buttons render a Radix Tooltip with `disabledReason`. Inline recovery CTA renders below button when `recovery !== null`.

Reasons map (ordered): No case loaded → Connecting → Sign in → Sweep in progress → EIG mutated dae (PF only) → PF prerequisite → SE measurements.

## Component testid conventions

- kebab-case scoped to feature: `bundle-export-dialog`, `analyze-sub-mode-eig`, `eig-scatter-point-{idx}`
- Group by panel/feature, not by component nesting
- Test-only — never used for styling or production behavior

## What survives a reload

- **Preferences** (layout, theme, units, recent cases) go to `localStorage`, each store with its own key and a reader that drops anything malformed.
- **Results** (finished TDS runs, the power flows kept for comparison) go to IndexedDB. `src/lib/resultsArchive.ts` is the only code that touches the database; `src/store/resultsPersistence.ts` puts back what it holds when the page loads and mirrors the two slices into it afterwards, so the archive holds what History and the Compare tab list and nothing else. A run is written once, when it finishes. Every tab on one origin shares the database and mirrors its own lists into it as if it were alone, so a tab can delete what another still lists. A tab posts `run-deleted` on the `tensa-results` `BroadcastChannel` once it has deleted a run, and a tab that hears it stops counting that run as kept (`isRunArchived`, so the unload guard asks again) and writes no more of it. Nothing else is reconciled between tabs: the run is not written back, kept power flows are not announced, and the `state` records are the last writer's. Changing the shape of a stored record means bumping `RESULTS_DB_VERSION` and handling the old shape in `onupgradeneeded`; a record the reader does not recognise is dropped and deleted, never guessed at.
- **Never stored in the browser**: session ids, job records (`store/jobs.ts`), request payloads, server paths and server error text. The database is readable by anything served from the same origin later (see `SECURITY.md`).
- `fake-indexeddb` (dev dependency) is the in-memory IndexedDB the unit tests run the archive against; pass a fresh `new IDBFactory()` per test. A typed array that comes back from it is from another realm, so check one with `ArrayBuffer.isView`, not `instanceof`.

## Codegen

OpenAPI types regenerated via `pnpm regen-api-types` after every new endpoint. Hand-authored brand types (`SessionId`, `RunId`, `EigResult`, etc.) live in `web/src/api/types.ts`.

## Lint, typecheck, format

- `pnpm lint --max-warnings 0` — must pass on every PR
- `pnpm typecheck` — must pass; pre-existing baseline errors are acknowledged inline
- `pnpm format:check` — prettier; auto-fix with `pnpm format`

## When in doubt

Read the closest existing example. The codebase converged on patterns over many sessions; reinventing creates drift. If the pattern feels wrong, propose a change in a brainstorm doc — don't fork silently.

## Code splitting

**The entry chunk holds only what the first paint needs.** It is whatever `src/main.tsx` reaches through static imports; a module reached only through `import()` becomes a chunk fetched when it is first used. Heavy or rarely used views load on demand:

- A panel or dialog is loaded with `lazyNamed` from `@/lib/lazyNamed` and rendered inside a `<Suspense>` (give a panel `LoadingPanel` from `@/components/ui/Lazy` as its fallback).
- A dialog that a store flag or a menu item opens is mounted through `<LazyMount when={open}>`, so its chunk is fetched on the first open and the dialog behaves as it did when it was always mounted. Pass `'overlay'` as `lazyNamed`'s third argument for it: if the chunk cannot be fetched (a page left open across an upgrade), that shows a toast, where a panel shows a reload prompt. Give the `LazyMount` an `onLoadFailed` that clears the flag, so nothing stays open on an empty screen and the next click toasts again instead of doing nothing.
- Whatever opens a lazy dialog must not import the dialog. Keep its open flag in `src/store/` (`reportDialog.ts`, `bundle.ts`) and its trigger button in a module of its own (`HistoryDrawerToggle.tsx`).

`tests/unit/lib/codeSplitting.test.ts` lists the modules and packages that must stay out of the entry chunk. Add a new lazy module there. A static import of one of them from eager code fails that test, and nothing else would notice.
