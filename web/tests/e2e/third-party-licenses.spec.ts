/**
 * The built UI carries the licences of the libraries it bundles, and the
 * server hands them out beside `index.html`.
 *
 * The build writes `THIRD-PARTY-LICENSES.txt` (`vite-plugins/thirdPartyLicenses.ts`),
 * and the Python package ships it with the UI. This reads it from a real
 * `tensa serve`, so it only runs in the mode where the substrate serves the
 * built UI (`E2E_NO_WEBSERVER`, see `playwright.config.ts`).
 */
import { test, expect } from './fixtures';

test.skip(
  !process.env.E2E_NO_WEBSERVER,
  'checks the built bundle, which only the substrate serves (see playwright.config.ts)',
);

test('the licences of the libraries the UI bundles are served beside it', async ({ request }) => {
  const response = await request.get('/THIRD-PARTY-LICENSES.txt');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toMatch(/^text\/plain/);
  const text = await response.text();

  // Libraries of the first load, of the lazily loaded panels, of the ELK
  // worker, and Tailwind, whose base styles are in the stylesheet.
  for (const [name, license] of [
    ['react', 'MIT'],
    ['react-dom', 'MIT'],
    ['@radix-ui/react-dialog', 'MIT'],
    ['@xyflow/react', 'MIT'],
    ['d3-zoom', 'ISC'],
    ['uplot', 'MIT'],
    ['apache-arrow', 'Apache-2.0'],
    ['elkjs', 'EPL-2.0 OR GPL-3.0-or-later'],
    ['tailwindcss', 'MIT'],
  ]) {
    // The list at the top: `  <name> <version> (<licence>)`, once for each
    // version bundled (cmdk brings an older Radix Dialog of its own).
    const listed = text
      .split('\n')
      .filter((line) => line.startsWith(`  ${name} `) && line.endsWith(` (${license})`));
    expect(listed.length, name).toBeGreaterThan(0);
  }
  // The Apache License asks for the NOTICE to be passed on.
  expect(text).toContain('NOTICE of apache-arrow:');
  expect(text).toContain('The Apache Software Foundation');
});
