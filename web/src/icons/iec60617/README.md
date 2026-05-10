# IEC 60617-style icon set

## Provenance

Authored from scratch following IEC 60617 (graphical symbols for diagrams)
conventions for power-systems one-line / single-line diagrams. **MIT-licensed**
under the same terms as the rest of `web/`. **Not derived from the IEC
publication itself** — the IEC standard is paid distribution and we did not
copy any of its files. Geometry was reconstructed from publicly-available
academic and reference materials (university course notes on one-line diagram
notation, ANDES's own documentation diagrams, Lucide-style SVG conventions for
sizing and stroke).

## Conventions

Every icon follows the same rules so the SLD canvas can scale and theme them
uniformly:

- **viewBox**: `0 0 24 24` for square symbols (transformers, generators,
  loads, shunts, ground). `0 0 24 6` for inherently horizontal symbols (`bus`,
  `line`).
- **Stroke**: `stroke="currentColor"` so the parent component controls color
  via Tailwind / CSS — needed for limit-violation overlays (R9) without
  per-icon color variants.
- **Stroke width**: `1.5` (Lucide-compatible). Bus uses a slightly heavier
  weight on the bar segment itself to read at small sizes.
- **Caps / joins**: `round`.
- **Fills**: `fill="none"` everywhere. The only exceptions are the small
  terminal dots on `line.svg`, which use `fill="currentColor"` for visibility
  at 24px.
- **No gradients, drop shadows, embedded raster, or `<style>` blocks.** Pure
  `<line>`, `<path>`, `<circle>` elements only.

These rules let each icon render cleanly at 24px (compact SLD), 48px (legend /
tooltip), and 96px (focused inspection) without retouching.

## Files

| File                   | Symbol                                   |
| ---------------------- | ---------------------------------------- |
| `bus.svg`              | Horizontal bus bar with end ticks        |
| `line.svg`             | Transmission line with terminal dots     |
| `transformer-2w.svg`   | Two-winding transformer (paired circles) |
| `transformer-3w.svg`   | Three-winding transformer (triangular)   |
| `generator.svg`        | Synchronous generator (circle + sine)    |
| `generator-syngen.svg` | Dynamic-modeled generator (extra wave)   |
| `load.svg`             | Composite load (triangle / arrow)        |
| `shunt-cap.svg`        | Shunt capacitor (parallel plates + gnd)  |
| `shunt-reactor.svg`    | Shunt reactor (coil + gnd)               |
| `ground.svg`           | Earth / ground reference                 |
| `manifest.ts`          | ANDES model class → icon URL mapping     |

## Coverage

The set covers exactly what the IEEE 14 / 39 / 118 / 300 and Kundur stock
cases require. ANDES model classes mapped by `manifest.ts`:

- `Bus` → `bus.svg`
- `Line` → `line.svg`
- `Transformer` / `Trafo` / `Trafo2` / `Transformer2W` → `transformer-2w.svg`
- `Trafo3` / `Transformer3W` → `transformer-3w.svg`
- `PV` / `Slack` / `SW` → `generator.svg`
- `GENROU` / `GENCLS` → `generator-syngen.svg`
- `PQ` / `ZIP` → `load.svg`
- `Shunt` / `ShuntCap` / `ShuntC` → `shunt-cap.svg`
- `ShuntL` / `ShuntReactor` → `shunt-reactor.svg`
- `Ground` → `ground.svg`

Unknown kinds fall back to `bus.svg` (see `iconForModel`).

## Deferred icons

The following IEC 60617 symbols are **deferred** — authored on demand when a
target case requires them rather than up-front speculation. Several were
explicitly considered against the v0.1 stock cases and confirmed absent.

- `breaker-open`, `breaker-closed` — switching devices (verify against stock
  cases before reactivating; IEEE 14/39/118/300 + Kundur do not require them)
- `fuse`
- `surge-arrester`
- `instrument-ct` (current transformer for instrumentation)
- `instrument-vt` (voltage / potential transformer)
- `motor` (induction / synchronous motor)
- `earthing-transformer` (zigzag grounding transformer)
- `voltage-source` (ideal Thevenin source)
- `current-source` (ideal Norton source)
- `switch` (manual disconnector, distinct from breaker)

When a future case introduces one of these, add it here, drop the SVG into
this directory, and extend `manifest.ts`.
