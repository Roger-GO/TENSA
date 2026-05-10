/**
 * Re-export shim for the canonical EmptyState component.
 *
 * Unit 8 introduced an EmptyState in this directory; Unit 13 promoted
 * the component to ``components/ui/EmptyState.tsx`` (the canonical UI
 * surface) and tightened the ``action`` contract to ``{ label, onClick }``.
 * This shim preserves the historical import path so call sites that
 * still reference ``@/components/shell/EmptyState`` continue to compile.
 *
 * New code should import from ``@/components/ui/EmptyState`` directly.
 */
export { EmptyState } from '@/components/ui/EmptyState';
export type { EmptyStateProps, EmptyStateAction } from '@/components/ui/EmptyState';
