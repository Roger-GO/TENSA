import { Suspense } from 'react';
import { LoadingPanel } from '@/components/ui/Lazy';
import { lazyNamed } from '@/lib/lazyNamed';
import type { AnalysisTabProps } from './AnalysisTab';

/**
 * ``AnalysisTab`` brings the plot (uPlot) and the EIG, CPF and SE charts with
 * it, and nothing shown before the first result needs them, so it loads when
 * the Analysis tab or the results view is first opened. The bottom drawer and
 * the results view both mount it from here, which keeps them on the same chunk.
 */
const AnalysisTab = lazyNamed(() => import('./AnalysisTab'), 'AnalysisTab');

export function LazyAnalysisTab(props: AnalysisTabProps) {
  return (
    <Suspense fallback={<LoadingPanel />}>
      <AnalysisTab {...props} />
    </Suspense>
  );
}
