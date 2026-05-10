# Web AGENTS guidance

Conventions for the React frontend at `web/`. Keeps the codebase consistent across hand-edits and AI-generated changes.

## Form-input contract

**Use `<Input>` from `@/components/ui/Input` for any controlled text or number input.** Raw `<input>` is fine for checkboxes, radios, and file pickers.

```tsx
import { Input } from "@/components/ui/Input";

<Input value={state} onChange={setState} placeholder="…" />
```

### Why
The native `<input>` controlled-component pattern has two non-obvious failure modes that `<Input>` papers over:

1. **IME composition (CJK, accented chars).** Calling parent `onChange` mid-composition produces partial text + lost characters. `<Input>` defers `onChange` until `compositionend` fires.
2. **Programmatic value setters in tests.** Setting `el.value = 'x'` + dispatching a synthetic `input` event bypasses React's onChange unless the test uses the React-friendly setter dance (`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(...)`). `<Input>` forwards correctly via React's controlled-component contract; tests using `userEvent.type()` or `locator.pressSequentially()` Just Work.

### Never use `defaultValue` for stateful inputs
`defaultValue` decouples the input from React state and breaks form validation, programmatic resets, and snapshot/restore flows. Always use `value + onChange`.

## Toast policy (Unit 3)

**Three rules:**

| Surface | Use |
|---|---|
| Form-validation errors ("Required", "Must be > tf") | Inline `role="alert"` next to the field. NEVER a toast. |
| Transient action results (export complete, snapshot saved, sweep cancelled) | `toast.success/.error/.warning/.info` from `@/lib/toast` |
| Recovery state transitions (session restored, substrate reconnected) | `toast.success` / `toast.error` with action button (Reload, Retry) |

```tsx
import { toast } from "@/lib/toast";

// Success after a button click that triggers a server action
toast.success("Bundle exported as andes-bundle-abc.zip");

// Error with retry CTA
toast.error("Snapshot save failed: disk full", {
  action: { label: "Retry", onClick: () => save() },
});
```

`<Toaster />` is mounted once at AppShell root. The lib (`sonner`) is lazy — DOM only renders after first toast fires.

## Keyboard shortcuts (Unit 6)

**Use `useHotkeys` from `@/lib/useHotkeys`** for any window-level keyboard binding. Defaults: `enableOnFormTags: false` + `enableOnContentEditable: false`, so shortcuts auto-skip when an editable element has focus.

```tsx
import { useHotkeys } from "@/lib/useHotkeys";

useHotkeys("?", () => openCheatsheet(), []);

// Special case: ⌘K palette is global — enable inside form tags
useHotkeys("meta+k", () => openCommandPalette(), [], {
  enableOnFormTags: ["INPUT", "TEXTAREA"],
});
```

For ad-hoc skip checks: `isEditableTarget(element)` / `isEditableActiveElement()`.

**Never** call `window.addEventListener("keydown", ...)` directly — bypasses the editable-element skip and contributes to state-leakage bugs.

## Run-button readiness (Unit 4)

**All Run buttons (PF / TDS / EIG / CPF / SE / Sweep) consume `useRunReadiness(routine)`** from `@/lib/useRunReadiness`. Returns `{ ready, disabledReason, recovery, recoveryHint }`.

```tsx
import { useRunReadiness } from "@/lib/useRunReadiness";

const { ready, disabledReason, recovery } = useRunReadiness("eig");
```

Disabled buttons render a Radix Tooltip with `disabledReason`. Inline recovery CTA renders below button when `recovery !== null`.

Reasons map (ordered): No case loaded → Connecting → Sign in → Sweep in progress → EIG mutated dae (PF only) → PF prerequisite → SE measurements.

## Component testid conventions

- kebab-case scoped to feature: `bundle-export-dialog`, `analyze-sub-mode-eig`, `eig-scatter-point-{idx}`
- Group by panel/feature, not by component nesting
- Test-only — never used for styling or production behavior

## Codegen

OpenAPI types regenerated via `pnpm regen-api-types` after every new endpoint. Hand-authored brand types (`SessionId`, `RunId`, `EigResult`, etc.) live in `web/src/api/types.ts`.

## Lint, typecheck, format

- `pnpm lint --max-warnings 0` — must pass on every PR
- `pnpm typecheck` — must pass; pre-existing baseline errors are acknowledged inline
- `pnpm format:check` — prettier; auto-fix with `pnpm format`

## When in doubt

Read the closest existing example. The codebase converged on patterns over many sessions; reinventing creates drift. If the pattern feels wrong, propose a change in a brainstorm doc — don't fork silently.
