/**
 * What the rows of the diagram search are and the words each is found by.
 *
 * Coverage:
 *
 *  - A node is classed by its type, and a generator or a controller by its
 *    ANDES model class too; a model of a generating unit by what it is to
 *    the unit.
 *  - A category is found by its words and by the start of one, never by the
 *    middle of one.
 *  - The words of a query name the categories they could mean.
 *  - The sentences built from the categories read as sentences.
 */
import { describe, expect, it } from 'vitest';
import {
  SEARCH_CATEGORIES,
  SEARCH_CATEGORY_ORDER,
  categoriesAsked,
  categoryCount,
  categoryFilterLabel,
  categoryHasWord,
  categoryOfNode,
  categoryOfRole,
  joinWords,
  searchTokens,
  type SearchCategory,
} from '@/components/sld/searchCategories';

describe('categoryOfNode', () => {
  it('classes a node by its type', () => {
    expect(categoryOfNode('bus', 'Bus')).toBe('bus');
    expect(categoryOfNode('load', 'PQ')).toBe('load');
    expect(categoryOfNode('shunt', 'Shunt')).toBe('shunt');
    expect(categoryOfNode('line', 'Line')).toBe('line');
    // A node with no type is drawn as a bus.
    expect(categoryOfNode(undefined, undefined)).toBe('bus');
  });

  it('tells a machine from a static generator by the model class', () => {
    expect(categoryOfNode('generator', 'PV')).toBe('generator');
    expect(categoryOfNode('generator', 'Slack')).toBe('generator');
    expect(categoryOfNode('generator', undefined)).toBe('generator');
    // A unit with no static generator is drawn under its machine.
    expect(categoryOfNode('generator', 'GENROU')).toBe('machine');
    expect(categoryOfNode('generator', 'GENCLS')).toBe('machine');
  });

  it('classes a controller badge by its model class', () => {
    expect(categoryOfNode('controller', 'EXST1')).toBe('exciter');
    expect(categoryOfNode('controller', 'TGOV1')).toBe('governor');
    expect(categoryOfNode('controller', 'IEEEST')).toBe('pss');
    expect(categoryOfNode('controller', 'REGCA1')).toBe('renewable');
    expect(categoryOfNode('controller', 'PMU')).toBe('measurement');
    expect(categoryOfNode('controller', 'TimeSeries')).toBe('profile');
    expect(categoryOfNode('controller', 'SomethingNew')).toBe('controller');
    expect(categoryOfNode('controller', undefined)).toBe('controller');
  });
});

describe('categoryOfRole', () => {
  it('classes a model of a unit by what it is to the unit', () => {
    expect(categoryOfRole('generator')).toBe('generator');
    expect(categoryOfRole('machine')).toBe('machine');
    expect(categoryOfRole('exciter')).toBe('exciter');
    expect(categoryOfRole('governor')).toBe('governor');
    expect(categoryOfRole('pss')).toBe('pss');
    expect(categoryOfRole('renewable')).toBe('renewable');
    expect(categoryOfRole('other')).toBe('controller');
  });
});

describe('the table of categories', () => {
  it('lists every category once, in the order shown', () => {
    const all = Object.keys(SEARCH_CATEGORIES) as SearchCategory[];
    expect([...SEARCH_CATEGORY_ORDER].sort()).toEqual([...all].sort());
    expect(new Set(SEARCH_CATEGORY_ORDER).size).toBe(SEARCH_CATEGORY_ORDER.length);
  });

  it('finds each category by its own name, one or several', () => {
    for (const category of SEARCH_CATEGORY_ORDER) {
      const { label, plural, words } = SEARCH_CATEGORIES[category];
      expect(categoryHasWord(category, label.toLowerCase())).toBe(true);
      // The last word of the plural: "other controllers" is found by "controllers".
      expect(categoryHasWord(category, plural.toLowerCase().split(' ').pop()!)).toBe(true);
      // A query is lower-cased before it is looked for.
      expect(words.every((word) => word === word.toLowerCase() && !word.includes(' '))).toBe(true);
    }
  });

  it('counts the static elements as static and every model of a run as dynamic', () => {
    const dynamic = SEARCH_CATEGORY_ORDER.filter((c) => SEARCH_CATEGORIES[c].dynamic);
    expect(dynamic).toEqual([
      'machine',
      'exciter',
      'governor',
      'pss',
      'renewable',
      'measurement',
      'profile',
      'controller',
    ]);
  });
});

describe('searchTokens', () => {
  it('splits a query into its words, lower case', () => {
    expect(searchTokens('  Governor   TGOV1_2 ')).toEqual(['governor', 'tgov1_2']);
    expect(searchTokens('')).toEqual([]);
    expect(searchTokens('   ')).toEqual([]);
  });
});

describe('categoryHasWord', () => {
  it('takes a word, another word for the same and the start of either', () => {
    expect(categoryHasWord('exciter', 'exciter')).toBe(true);
    expect(categoryHasWord('exciter', 'exciters')).toBe(true);
    expect(categoryHasWord('exciter', 'exc')).toBe(true);
    expect(categoryHasWord('exciter', 'avr')).toBe(true);
    expect(categoryHasWord('governor', 'gov')).toBe(true);
    expect(categoryHasWord('pss', 'stabilizer')).toBe(true);
    expect(categoryHasWord('pss', 'stabiliser')).toBe(true);
    expect(categoryHasWord('machine', 'sg')).toBe(true);
  });

  it('does not take the middle of a word, or a word of another category', () => {
    expect(categoryHasWord('generator', 'rat')).toBe(false);
    expect(categoryHasWord('bus', 'us')).toBe(false);
    expect(categoryHasWord('load', 'exciter')).toBe(false);
    expect(categoryHasWord('measurement', 'controller')).toBe(false);
  });
});

describe('categoriesAsked', () => {
  it('names the categories a word could mean', () => {
    expect(categoriesAsked(['exciter'])).toEqual(['exciter']);
    expect(categoriesAsked(['avr'])).toEqual(['exciter']);
    expect(categoriesAsked(['transformer'])).toEqual(['line']);
    expect(categoriesAsked(['generator'])).toEqual(['generator', 'machine']);
    expect(categoriesAsked(['controller'])).toEqual([
      'exciter',
      'governor',
      'pss',
      'renewable',
      'controller',
    ]);
  });

  it('names none for a word that is no kind, and takes any word of several', () => {
    expect(categoriesAsked(['tgov1_2'])).toEqual([]);
    expect(categoriesAsked([])).toEqual([]);
    expect(categoriesAsked(['zzz', 'load'])).toEqual(['load']);
  });
});

describe('the words of a sentence', () => {
  it('names a filter by the plural, capitalised', () => {
    expect(categoryFilterLabel('bus')).toBe('Buses');
    expect(categoryFilterLabel('exciter')).toBe('Exciters');
    expect(categoryFilterLabel('pss')).toBe('PSS');
    expect(categoryFilterLabel('controller')).toBe('Other controllers');
  });

  it('counts one and several', () => {
    expect(categoryCount('governor', 4)).toBe('4 governors');
    expect(categoryCount('machine', 1)).toBe('1 machine');
    expect(categoryCount('bus', 0)).toBe('0 buses');
    // An abbreviation keeps its capitals.
    expect(categoryCount('pss', 1)).toBe('1 PSS');
    expect(categoryCount('pss', 2)).toBe('2 PSS');
  });

  it('joins a list with its last word', () => {
    expect(joinWords([], 'or')).toBe('');
    expect(joinWords(['a'], 'or')).toBe('a');
    expect(joinWords(['a', 'b'], 'or')).toBe('a or b');
    expect(joinWords(['a', 'b', 'c'], 'and')).toBe('a, b and c');
  });
});
