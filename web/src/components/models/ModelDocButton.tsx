import { Button } from '@/components/ui/button';
import { useModelDocStore } from '@/store/modelDoc';

/**
 * ModelDocButton. Opens the Model documentation dialog on the model it sits
 * beside. It must not import the dialog: the dialog is a separate chunk that
 * loads the first time it is opened, and this button is rendered by code of
 * the first load.
 */
export interface ModelDocButtonProps {
  model: string;
  className?: string;
}

export function ModelDocButton({ model, className }: ModelDocButtonProps) {
  const openDialog = useModelDocStore((s) => s.openDialog);
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => openDialog(model)}
      aria-label={`Model documentation for ${model}`}
      title="Model documentation"
      data-testid="model-doc-open"
      className={className}
    >
      ?
    </Button>
  );
}
