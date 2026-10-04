/**
 * Line loading rules: the bands a loading percentage falls in, how it prints,
 * and the words for it. A line the case gives no rating has no loading and is
 * never judged.
 */
import { describe, expect, it } from 'vitest';
import {
  LOADING_LIMIT_PCT,
  LOADING_WARNING_PCT,
  assessLoading,
  formatLoading,
  loadingCheckText,
  loadingStatusText,
} from '@/components/sld/loading';

describe('assessLoading', () => {
  it('is danger only past the rating, and warning from the warning level up to it', () => {
    expect(assessLoading(LOADING_LIMIT_PCT + 0.01)).toBe('danger');
    expect(assessLoading(250)).toBe('danger');
    // Exactly at the rating is full, not over.
    expect(assessLoading(LOADING_LIMIT_PCT)).toBe('warning');
    expect(assessLoading(LOADING_WARNING_PCT)).toBe('warning');
    expect(assessLoading(LOADING_WARNING_PCT - 0.01)).toBe('success');
    expect(assessLoading(0)).toBe('success');
  });

  it('has nothing to judge for a line with no rating or no reading', () => {
    expect(assessLoading(null)).toBe('neutral');
    expect(assessLoading(undefined)).toBe('neutral');
    expect(assessLoading(Number.NaN)).toBe('neutral');
    expect(assessLoading(Number.POSITIVE_INFINITY)).toBe('neutral');
  });
});

describe('loading text', () => {
  it('prints one decimal and a percent sign', () => {
    expect(formatLoading(87.34)).toBe('87.3%');
    expect(formatLoading(100)).toBe('100.0%');
    expect(formatLoading(0)).toBe('0.0%');
  });

  it('says why a line is flagged, and nothing for a line that is not', () => {
    expect(loadingStatusText('danger')).toBe('Over rating');
    expect(loadingStatusText('warning')).toBe('Near rating');
    expect(loadingStatusText('success')).toBeNull();
    expect(loadingStatusText('neutral')).toBeNull();
  });

  it('gives a table cell a verdict for every rated line and none for an unrated one', () => {
    expect(loadingCheckText(120)).toBe('Over rating');
    expect(loadingCheckText(90)).toBe('Near rating');
    expect(loadingCheckText(40)).toBe('Within rating');
    expect(loadingCheckText(null)).toBeNull();
  });
});
