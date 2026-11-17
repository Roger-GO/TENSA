/**
 * Entries of the example catalog as `GET /examples` answers them, for the tests of the
 * Example cases dialog and of what reads an entry. `makeExample` fills in an entry and
 * takes what a test cares about as overrides.
 */
import type { ExampleListEntry } from '@/api/types';

export function makeExample(overrides: Partial<ExampleListEntry> = {}): ExampleListEntry {
  return {
    id: 'ieee14',
    title: 'IEEE 14-bus, with machines and controls',
    summary: 'The IEEE 14-bus system with machines, exciters and governors.',
    category: 'dynamic',
    tags: ['ieee', '14-bus'],
    size: { buses: 14, generators: 5 },
    analyses: ['pf', 'tds', 'eig'],
    default: true,
    provenance: {
      kind: 'andes',
      path: 'ieee14/ieee14_full.xlsx',
      sha256: 'ed5a7551ca9258fba9988fc8bdf9d66842f786141d607b99f389a1b6c52bc137',
      release: 'ANDES 2.0.0',
      source_url: 'https://github.com/CURENT/andes/blob/v2.0.0/andes/cases/ieee14/ieee14_full.xlsx',
      retrieved: '2026-11-17',
    },
    extra_files: [],
    citations: [
      {
        text: 'IEEE 14 Bus Test Case, University of Washington.',
        bibtex: '@misc{uw_ieee14,\n  title = {{IEEE} 14 Bus Test Case}\n}',
        url: 'https://labs.ece.uw.edu/pstca/pf14/pg_tca14bus.htm',
      },
      {
        text: 'H. Cui, F. Li and K. Tomsovic, ANDES, doi:10.1109/TPWRS.2020.3017019.',
        bibtex: '@article{cui2021andes,\n  title = {ANDES}\n}',
        doi: '10.1109/TPWRS.2020.3017019',
        url: 'https://doi.org/10.1109/TPWRS.2020.3017019',
      },
    ],
    licence: {
      name: 'GPL-3.0-or-later',
      url: 'https://github.com/CURENT/andes/blob/v2.0.0/LICENSE',
      attribution: 'ANDES asks that research that uses it cite its paper.',
    },
    modifications: [],
    caveats: ['The power flow data has not been compared with the UW archive.'],
    verification: null,
    links: [],
    in_workspace: false,
    available: true,
    ...overrides,
  };
}

/** A dynamic case, a steady-state case and an entry that is only links. */
export function makeCatalog(): ExampleListEntry[] {
  return [
    makeExample(),
    makeExample({
      id: 'wscc9',
      title: 'WSCC 9-bus, network only',
      summary: 'The WSCC 3-machine, 9-bus network, for power flow.',
      category: 'steady-state',
      tags: ['wscc'],
      size: { buses: 9, generators: 3 },
      analyses: ['pf'],
      provenance: {
        kind: 'andes',
        path: 'wscc9/wscc9.xlsx',
        sha256: '1e994b2b4c67bdcccf52b9007cf03c5c010f6ff72bcfe055c4c3b776baf51de8',
        release: 'ANDES 2.0.0',
        source_url: 'https://github.com/CURENT/andes/blob/v2.0.0/andes/cases/wscc9/wscc9.xlsx',
      },
      caveats: [],
      citations: [
        {
          text: 'P. M. Anderson and A. A. Fouad, Power System Control and Stability.',
          bibtex: '@book{af}',
        },
      ],
      licence: { name: 'GPL-3.0-or-later' },
    }),
    makeExample({
      id: 'texas-dynamic',
      title: 'Texas A&M dynamic files',
      summary: 'Dynamic data for the synthetic grids, which TENSA cannot redistribute.',
      category: 'dynamic',
      tags: ['texas'],
      size: null,
      analyses: [],
      default: false,
      provenance: { kind: 'external' },
      citations: [],
      licence: { name: 'Terms of the Texas A&M archive' },
      caveats: [],
      links: [
        {
          title: 'Electric Grid Test Case Repository',
          url: 'https://electricgrids.engr.tamu.edu/',
          note: 'Download the files there and add them with Add files.',
        },
      ],
      available: false,
    }),
  ];
}
