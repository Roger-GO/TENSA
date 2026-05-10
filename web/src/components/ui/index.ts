/**
 * Barrel for the project-built component library (Unit 2).
 *
 * Each module exports named components only — no defaults — so consumers can
 * tree-shake unused primitives and so re-exports stay explicit. Components
 * are organized by Radix primitive (one wrapper per primitive) plus three
 * layout primitives at the bottom.
 */

export { Button } from './button';
export type { ButtonProps, ButtonVariant, ButtonSize } from './button';

export { Input } from './Input';
export type { InputProps } from './Input';

export {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogClose,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from './dialog';
export type { DialogContentProps } from './dialog';

export { TooltipProvider, Tooltip, TooltipTrigger, TooltipPortal, TooltipContent } from './tooltip';

export { Popover, PopoverTrigger, PopoverAnchor, PopoverPortal, PopoverContent } from './popover';

export { Tabs, TabsList, TabsTrigger, TabsContent } from './tabs';

export { ScrollArea, ScrollBar } from './scroll-area';

export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
} from './select';

export { Slider } from './slider';

export { ToggleGroup, ToggleGroupItem } from './toggle-group';

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuGroup,
  ContextMenuPortal,
  ContextMenuSub,
  ContextMenuRadioGroup,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
} from './context-menu';

export { Stack } from './stack';
export type { StackProps, StackAlign, StackJustify, SpacingStep } from './stack';
export { Inline } from './inline';
export type { InlineProps } from './inline';
export { Box } from './box';
export type { BoxProps } from './box';
