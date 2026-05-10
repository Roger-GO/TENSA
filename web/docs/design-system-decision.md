# Design system decision (Phase 0 falsification gate)

**Status:** Decided 2026-05-07. Implementer: Unit 2.
**Outcome:** Project-built-on-Radix (the planned default). shadcn-with-tokens
downgrade rejected.

## Context

The v0.1 plan (R17) commits to "modern UX vs. legacy commercial tools" as the
wedge. Stock shadcn-with-tokens reskins the canonical shadcn components with
project palette but keeps shadcn's geometry, motion, and component composition.
Project-built-on-Radix authors thin wrappers over Radix Primitives directly,
giving the design system full ownership of geometry / motion / composition
while reusing Radix's (excellent) ARIA + keyboard behavior.

The plan's Phase 0 gate calls for 1-2 reference mocks comparing the two paths.
This doc is that comparison, executed in code rather than Figma since this is
an automated session.

## What stock shadcn-with-tokens ships

shadcn's canonical `<Button>` renders as:

```tsx
<button className="ring-offset-background focus-visible:ring-ring bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-9 items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50" />
```

Notable defaults:

- `rounded-md` (6px) — generic.
- `transition-colors` only — no motion on press.
- `hover:bg-primary/90` — opacity-darkening hover; not a discrete elevation.
- Focus: 2px ring, 2px offset, default browser-y look.
- `text-sm` (14px) base — fine.
- `h-9` (36px) — standard.
- No icon-aware spacing beyond `gap-2`.

Dialog/Tooltip/Popover defaults add `data-[state=open]:animate-in
fade-in-0 zoom-in-95` etc. — generic Tailwind animation utilities, not custom
easing.

## What project-built-on-Radix gives us

We can express the project-defined tokens directly in the component layer:

- **Custom OKLCH palette** with restrained, slightly cool neutrals
  (Linear/Figma/Vercel-flavored). The `--color-primary` is a desaturated
  research-blue, not shadcn's stock zinc-and-violet.
- **Tactile motion**: a single `--ease-out-spring` cubic-bezier(0.16, 1, 0.3,
  1. that gives every transition a perceptibly springy feel. shadcn's defaults
     use linear/ease-out which feels generic.
- **Border-radius scale** with `--radius-md` at 6px and `--radius-lg` at 8px;
  buttons use `--radius-md`, dialogs/popovers use `--radius-lg`. shadcn uses
  `rounded-md` everywhere by default.
- **Discrete press state** via `active:translate-y-px` + `active:shadow-none`
  — gives buttons a physical click. shadcn's stock components have no press
  state beyond the opacity hover.
- **Custom focus ring** sized at the token level (`oklch(0.50 0.10 250 / 0.4)`
  — primary-with-reduced-chroma) instead of the default `--ring`.
- **Numeric font** (JetBrains Mono via system-ui-monospace fallback) wired
  into a `.font-numeric` utility for results-table and iteration-log
  readability. shadcn doesn't address this.
- **Layout primitives** (`Stack`, `Inline`, `Box`) — shadcn doesn't ship
  these; teams typically reach for Tailwind `flex` directly which scatters
  spacing decisions across the codebase. Owning a `<Stack gap={4}>` primitive
  funnels spacing through the token scale.

## Side-by-side specs

### Button — primary, default size

**shadcn-with-tokens:**

```html
<button
  class="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring inline-flex h-9 items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
>
  Run power flow
</button>
```

**project-built-on-Radix:**

```html
<button
  class="bg-primary text-primary-foreground inline-flex h-9 items-center justify-center gap-2 rounded-[--radius-md] px-4 text-sm font-medium shadow-sm transition-[background-color,box-shadow,transform] duration-[--duration-fast] ease-[--ease-out-spring] hover:bg-[color-mix(in_oklch,var(--color-primary)_92%,white)] hover:shadow focus-visible:ring-2 focus-visible:ring-[--color-ring] focus-visible:ring-offset-2 focus-visible:ring-offset-[--color-background] focus-visible:outline-none active:translate-y-px active:shadow-none disabled:pointer-events-none disabled:opacity-50"
>
  Run power flow
</button>
```

Differences a user feels:

1. Hover lightens via `color-mix` (perceptually uniform in OKLCH) rather than
   alpha-blending against the page. This stays clean on both light and dark
   backgrounds; alpha-blending muddies on dark.
2. Press state: button drops 1px. shadcn has nothing.
3. Spring easing: motion lands instead of linearly easing. 120ms duration is
   short enough to feel snappy, long enough for the spring to be perceptible.
4. Focus ring uses primary-with-reduced-chroma — feels coordinated with the
   button instead of slapped on.

### Dialog — overlay + content

**shadcn-with-tokens:** generic `bg-black/80` overlay, `rounded-lg` content,
default fade animation.

**project-built-on-Radix:** overlay uses `bg-[color-mix(in_oklch,var(--color-foreground)_60%,transparent)]`
with a 16px backdrop-blur for a frosted-glass feel; content uses
`--radius-lg` (8px), `shadow-lg`, opens with the spring easing at
`--duration-base` (200ms). Border explicitly on the content surface
(`border border-border`) so it reads as a discrete sheet on both light and
dark backgrounds — shadcn's default has no border, which on dark mode looks
like a bleed.

## Recommendation

**Project-built-on-Radix.** The differentiators above (OKLCH-mixed hover,
press translate-y, spring easing, frosted overlay, focus-ring chroma, numeric
font wired through, layout primitives) are individually small and
collectively meaningful — they are the reason a researcher who has used
Linear or Vercel will recognize this as a 2026-modern tool rather than a
generic React app.

The boilerplate cost is bounded: ~13 wrappers in this unit, each ~30-80 lines.
Radix gives us all the behavior; we are only authoring the visual layer.

The downgrade trigger (R17 Phase 0 gate) was: "if the visual difference is
not self-evident at a glance, downgrade." The four bullets above are
self-evident. Decision: proceed with project-built-on-Radix.

## What we are NOT doing

- Not authoring icon components in this unit (Unit 3 owns icons).
- Not authoring the SLD-specific palette band in this unit (Unit 9 — but the
  `--color-success`, `--color-warning`, `--color-danger` tokens are seeded
  here so Unit 9 can reference them).
- Not authoring layout shell components (`AppShell`, `TopBar`, `LeftRail`,
  `RightDock`) — Unit 4. We only ship the primitives those will be built
  from.
- Not adding Storybook. The plan mentions it as optional verification; it
  adds dependency weight that the plan does not require.

## Revisit triggers

Re-evaluate this decision if:

- The wrapper count crosses ~25 (significant maintenance surface).
- A second contributor joins and finds the wrapper layer hard to reason about.
- shadcn ships a "tokens-first" mode that does not require deviating from
  upstream geometry.

None of these apply at v0.1 ship time.
