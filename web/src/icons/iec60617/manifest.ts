// IEC 60617-style icon manifest: maps ANDES model class names → SVG asset URL.
//
// Coverage scope: IEEE 14 / 39 / 118 / 300 + Kundur stock cases (per the v0.1
// plan, Unit 3). Model classes outside this scope fall back to `bus.svg` so the
// SLD canvas always renders something rather than crashing on an unknown kind.
//
// Vite resolves these `?url` imports to the final hashed asset URL at build
// time (and to a dev-server URL in `pnpm dev`). Consumers receive a string and
// can drop it into an <img src> or fetch it for inline-SVG injection.

import busUrl from './bus.svg?url';
import lineUrl from './line.svg?url';
import transformer2wUrl from './transformer-2w.svg?url';
import transformer3wUrl from './transformer-3w.svg?url';
import generatorUrl from './generator.svg?url';
import generatorSyngenUrl from './generator-syngen.svg?url';
import loadUrl from './load.svg?url';
import shuntCapUrl from './shunt-cap.svg?url';
import shuntReactorUrl from './shunt-reactor.svg?url';
import groundUrl from './ground.svg?url';

/**
 * Raw map from ANDES model class name → resolved SVG URL.
 *
 * Keys mirror the `kind` strings the substrate's topology endpoint emits.
 * Multiple ANDES classes can map to the same icon when they share a one-line
 * diagram convention (e.g., PV / Slack both render as a generator symbol).
 */
export const iconManifest: Readonly<Record<string, string>> = Object.freeze({
  // Buses
  Bus: busUrl,

  // Transmission lines / branches
  Line: lineUrl,

  // Transformers
  Transformer: transformer2wUrl,
  Trafo: transformer2wUrl,
  Trafo2: transformer2wUrl,
  Transformer2W: transformer2wUrl,
  Trafo3: transformer3wUrl,
  Transformer3W: transformer3wUrl,

  // Static generators (power-flow only)
  PV: generatorUrl,
  Slack: generatorUrl,
  SW: generatorUrl,

  // Dynamic synchronous generators (TDS-modeled)
  GENROU: generatorSyngenUrl,
  GENCLS: generatorSyngenUrl,

  // Loads
  PQ: loadUrl,
  ZIP: loadUrl,

  // Shunts — capacitive
  Shunt: shuntCapUrl,
  ShuntCap: shuntCapUrl,
  ShuntC: shuntCapUrl,

  // Shunts — inductive
  ShuntL: shuntReactorUrl,
  ShuntReactor: shuntReactorUrl,

  // Reference / ground (rarely emitted directly by stock cases; included for
  // completeness so the SLD can annotate explicit ground references).
  Ground: groundUrl,
});

/**
 * The URL used when a model class is not found in the manifest. Renders a bus
 * symbol so the canvas stays visually coherent.
 */
export const fallbackIconUrl: string = busUrl;

/**
 * Resolve an ANDES model class name to its icon URL.
 *
 * Matching is exact and case-sensitive: ANDES emits canonical class names
 * (e.g., `GENROU`, not `genrou`), and silently coercing case would mask
 * substrate bugs. Unknown kinds fall back to `bus.svg`.
 */
export function iconForModel(model: string): string {
  return iconManifest[model] ?? fallbackIconUrl;
}
