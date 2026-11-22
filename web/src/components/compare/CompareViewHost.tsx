/**
 * Mounts the compare view the first time its store flag is set, as
 * ``ExampleCasesHost`` does for its dialog: the view is a chunk of its own,
 * fetched on the first open, and the triggers (the command, the plot's export
 * menu) never import it.
 */
import { LazyMount } from '@/components/ui/Lazy';
import { lazyNamed } from '@/lib/lazyNamed';
import { useCompareViewStore } from '@/store/compareView';

const CompareView = lazyNamed(() => import('./CompareView'), 'CompareView', 'overlay');

export function CompareViewHost() {
  const open = useCompareViewStore((s) => s.open);
  const close = useCompareViewStore((s) => s.closeCompareView);
  return (
    <LazyMount when={open} onLoadFailed={close}>
      <CompareView />
    </LazyMount>
  );
}
