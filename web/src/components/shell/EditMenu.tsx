/**
 * EditMenu — TopBar dropdown housing in-session edit history actions
 * (Unit 8 of the v2.0 polish plan).
 *
 * Items:
 *
 * - "Undo last edit"  — drops the most recent ``add()`` (per the
 *                       WorkflowToolbar's Undo button).
 * - "Reload from file" — re-parses the on-disk case and discards every
 *                        local edit (per the WorkflowToolbar's Reload
 *                        button + confirm dialog).
 *
 * The actions live in ``WorkflowToolbar``: it owns the mutation hooks,
 * pending states, error inline-display, and the reload-confirm dialog.
 * Embedding the existing component (rather than reimplementing 100+
 * lines of mutation glue) keeps behaviour parity with the standalone
 * tests in ``tests/unit/components/case/WorkflowToolbar.test.tsx``.
 */
import { TopBarMenu } from './TopBarMenu';
import { WorkflowToolbar } from '@/components/case/WorkflowToolbar';

export function EditMenu() {
  return (
    <TopBarMenu label="Edit" testId="topbar-menu-edit">
      <div className="flex flex-col gap-1 p-1 [&_button]:w-full [&_button]:justify-start">
        <WorkflowToolbar />
      </div>
    </TopBarMenu>
  );
}
