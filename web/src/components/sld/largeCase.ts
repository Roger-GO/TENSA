/**
 * The most buses a case has and its diagram is still drawn the moment the
 * case opens. The picture of a diagram (`pictureOf`: the bars, the taps, every
 * line, the labels) is redone whenever something on the canvas changes, and its
 * time grows much faster than the number of buses: under a second at 300 buses
 * (IEEE 300), nearly five minutes at 1354 (PEGASE), during which the page does
 * not answer. A case above this is not drawn until the person asks for it
 * (`SldTooLarge`); its tables, power flow, violations and exports do not need
 * the diagram.
 */
export const DRAW_AT_ONCE_BUSES = 400;

/** True when a case of `buses` buses is not drawn until it is asked for. */
export function tooLargeToDraw(buses: number): boolean {
  return buses > DRAW_AT_ONCE_BUSES;
}
