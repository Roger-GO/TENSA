/**
 * Custom ESLint rule: no-destructive-token.
 *
 * Background (v3.1 Unit 10): the Tailwind theme in this codebase defines a
 * `danger` color token but NOT a `destructive` one. Any utility class of the
 * form `(bg|text|border|ring|outline)-destructive` — or the bare
 * `destructive` / `destructive-foreground` token used inside a Tailwind
 * class string — therefore silently NO-OPs (renders unstyled). This rule
 * guards against re-introducing those dead classes after the destructive→danger
 * sweep.
 *
 * Scope: the rule only inspects STRING and TEMPLATE-LITERAL values (the places
 * className tokens actually live in source). It never looks at comments, so a
 * doc-comment that legitimately names the rule (e.g. "NEVER use destructive")
 * does not trip it, and it does not false-positive on unrelated identifiers
 * such as a variable named `destructive`.
 *
 * Matched patterns (word-boundary anchored so `danger`/`danger-foreground`
 * and substrings are unaffected):
 *   - (bg|text|border|ring|outline)-destructive            e.g. bg-destructive
 *   - (bg|text|border|ring|outline)-destructive-foreground e.g. text-destructive-foreground
 *   - bare `destructive` / `destructive-foreground` appearing as a standalone
 *     class token inside a string that already looks like a Tailwind class
 *     list (i.e. another token in the string uses a `*-destructive` form, or
 *     the value is whitespace-separated class-like tokens). To stay safe we
 *     only flag the bare form when it is preceded by a `-` (utility prefix)
 *     OR is one of several space-separated tokens — handled by the regex below.
 */

// Utility-prefixed destructive classes (the always-dead ones).
const PREFIXED_DESTRUCTIVE = /\b(?:bg|text|border|ring|outline)-destructive(?:-foreground)?\b/;

// Bare destructive token (`destructive` / `destructive-foreground`) used as a
// standalone class word — it must be a whole whitespace-delimited token so
// identifiers like `isDestructiveAction` never match.
const BARE_DESTRUCTIVE_TOKEN = /^destructive(?:-foreground)?$/;

// A Tailwind-utility-shaped token: a `prefix-value` (e.g. `bg-danger`,
// `px-2`), a variant (`hover:bg-x`), or an arbitrary value (`w-[3px]`). We use
// this to confirm a string is a class LIST (and not English prose) before
// flagging a bare `destructive` word — prose tokens like "action"/"and" are
// not utility-shaped, whereas real class strings carrying a bare token always
// sit next to other utilities.
const UTILITY_SHAPED = /[:[\]/]|^[a-z][a-z0-9]*-[a-z0-9[]/;

/**
 * @param {string} value raw string value to inspect
 * @returns {boolean} whether the value contains a dead destructive token
 */
function containsDestructiveToken(value) {
  if (PREFIXED_DESTRUCTIVE.test(value)) {
    return true;
  }
  // Bare-token case: only when the string reads as a Tailwind class list, i.e.
  // it contains a bare `destructive` token AND at least one other token that is
  // unmistakably a utility class. This keeps prose ("…is destructive and…")
  // and identifiers from tripping the rule.
  const tokens = value.split(/\s+/).filter(Boolean);
  const hasBare = tokens.some((t) => BARE_DESTRUCTIVE_TOKEN.test(t));
  if (hasBare) {
    const hasOtherUtility = tokens.some(
      (t) => !BARE_DESTRUCTIVE_TOKEN.test(t) && UTILITY_SHAPED.test(t),
    );
    if (hasOtherUtility) {
      return true;
    }
  }
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow the dead `destructive` Tailwind token; use the `danger` token instead.',
    },
    schema: [],
    messages: {
      noDestructive:
        'The `destructive` Tailwind token is not defined and renders unstyled — use the `danger` token (e.g. `bg-danger`, `text-danger-foreground`) instead.',
    },
  },

  create(context) {
    /**
     * @param {import('estree').Node} node
     * @param {string} value
     */
    function check(node, value) {
      if (typeof value === 'string' && containsDestructiveToken(value)) {
        context.report({ node, messageId: 'noDestructive' });
      }
    }

    return {
      Literal(node) {
        if (typeof node.value === 'string') {
          check(node, node.value);
        }
      },
      TemplateElement(node) {
        const raw = node.value && node.value.cooked;
        if (typeof raw === 'string') {
          check(node, raw);
        }
      },
    };
  },
};

export default rule;
