import { useCaseStore } from '@/store/case';
import { cn } from '@/lib/cn';
import { ElementFormFields } from './ElementFormFields';
import { GeneratingUnitSection } from './GeneratingUnitSection';
import { RouteSection } from './RouteSection';

/**
 * PropertiesAccordion (v3 Unit 8).
 *
 * The Properties section of the RightInspector accordion. Wraps the
 * ``ElementFormFields`` component (extracted from ``ElementInspector``)
 * so the existing form-by-type rendering body is reused as-is.
 *
 * Empty state: when no element is selected the section shows brief
 * placeholder text. The accordion shell itself only mounts when there's
 * a selection (RightInspector renders an EmptyState upstream when no
 * element is selected); this is a defensive fallback.
 */

export interface PropertiesAccordionProps {
  className?: string;
}

export function PropertiesAccordion({ className }: PropertiesAccordionProps) {
  const selectedElement = useCaseStore((s) => s.selectedElement);
  return (
    <div data-testid="properties-accordion" className={cn('flex flex-col gap-2', className)}>
      {selectedElement ? (
        <>
          <ElementFormFields />
          {/* The generating unit the selection is a model of: the generator,
              its machine and their controllers, each one press away. */}
          {selectedElement.kind === 'generator' || selectedElement.kind === 'controller' ? (
            <GeneratingUnitSection />
          ) : null}
          {/* How the line is drawn on the diagram, and its route moved by hand or reset. */}
          {selectedElement.kind === 'line' || selectedElement.kind === 'transformer' ? (
            <RouteSection />
          ) : null}
        </>
      ) : (
        <p className="text-muted-foreground text-xs">
          Select an element on the canvas to view its properties.
        </p>
      )}
    </div>
  );
}
