/**
 * The most buses a case has and its diagram is still drawn the moment the
 * case opens. The picture of a diagram (`pictureOf`: the bars, the taps, every
 * line, the labels) is made again whenever something on the canvas changes,
 * and several times as a case opens, so a diagram of this size is made in a
 * few seconds and one of a thousand buses in minutes, during which the page
 * does not answer. A case above this is not drawn until the person asks for it
 * (`SldTooLarge`); its tables, power flow, violations and exports do not need
 * the diagram.
 */
export const DRAW_AT_ONCE_BUSES = 400;

/**
 * The most buses a case has and its diagram is offered on request. Measured
 * in headless Chromium on a fast desktop, from the click to the first nodes
 * on screen, with the page unresponsive meanwhile (cases made of the first
 * 500, 700 and 1000 buses around the busiest bus of PEGASE 1354, and the two
 * bundled large cases): 55 s at 500 buses, 157 s at 700, 303 s for ACTIVSg2000
 * (2000 buses), 795 s for PEGASE 1354. The server closes the session of a page
 * that has not checked in for three minutes, which a page that does not
 * answer cannot, and the page then reconnects and begins again: the last
 * two never ended in a diagram, and 700 came within 25 s of it. 500 leaves
 * three times the room, so above it the diagram is not offered at all.
 */
export const DRAW_ON_REQUEST_BUSES = 500;

/** True when a case of `buses` buses is not drawn until it is asked for. */
export function tooLargeToDraw(buses: number): boolean {
  return buses > DRAW_AT_ONCE_BUSES;
}

/** True when the diagram of a case of `buses` buses is not offered, even on request. */
export function tooLargeToOffer(buses: number): boolean {
  return buses > DRAW_ON_REQUEST_BUSES;
}
