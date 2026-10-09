/**
 * The rule by which Tidy diagram leaves a line where it runs, in the words every
 * place that states it uses: the tooltip of the button, the command of the
 * palette and the two notices of the canvas.
 *
 * It is `betterRoute` in `components/sld/tidyPlan.ts` put into a sentence: a
 * route that holds is replaced only by one that is no longer, has no more bends,
 * is crossed in no more places, and is less of one of the three. So a route of
 * the same length with a bend fewer replaces it as well, which "unless a shorter
 * one is found", as these places used to say, left out.
 */

/** What makes a route the better one. */
const BETTER =
  'no longer, with no more bends, crossed in no more places, and less of one of the three';

/** The rule, as a sentence of its own. */
export const TIDY_KEEP_RULE = `A line keeps the route it has unless a better one is found: ${BETTER}.`;

/** Why a tidy changed nothing, to follow "Every line and transformer keeps its route: ". */
export const TIDY_NONE_BETTER = `none has a better one (${BETTER})`;
