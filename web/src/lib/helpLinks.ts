/**
 * Where the Help menu and the About dialog send a reader who wants more than the
 * UI says: the API reference this server serves, the API map written for LLM
 * agents, ANDES's own model reference, and the source.
 */
export const REPO_URL = 'https://github.com/Roger-GO/TENSA';

export interface HelpLink {
  /** Stable kebab-case id, used in test ids. */
  id: string;
  label: string;
  /** Where it goes, in a few words (shown beside the label). */
  hint: string;
  href: string;
}

export const HELP_LINKS: readonly HelpLink[] = [
  // Served by this server at the root, next to the app (Swagger UI over the OpenAPI schema).
  { id: 'api-docs', label: 'API reference', hint: '/docs', href: '/docs' },
  // Lives in the repository, not in the wheel the server runs from.
  {
    id: 'llms',
    label: 'API map for agents',
    hint: 'llms.txt',
    href: `${REPO_URL}/blob/main/llms.txt`,
  },
  // The stable docs track the released ANDES that TENSA is verified against (2.0).
  {
    id: 'andes-models',
    label: 'ANDES model docs',
    hint: 'docs.andes.app',
    href: 'https://docs.andes.app/en/stable/reference/models/index.html',
  },
  { id: 'repo', label: 'TENSA on GitHub', hint: 'Roger-GO/TENSA', href: REPO_URL },
];
