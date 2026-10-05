import { useState } from 'react';
import type { ReactNode } from 'react';
import { isWaitingForSession, useTdsControllers } from '@/api/queries';
import type { TdsControllerCatalogue, TdsControllerTarget } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/Input';
import { cn } from '@/lib/cn';
import {
  CONTROLLER_TYPE_HINTS,
  CONTROLLER_TYPE_LABELS,
  MAX_TDS_CONTROLLERS,
  defaultDraft,
  describeController,
  describeResult,
  draftFromSpec,
  entryFromDraft,
  formatNumber,
  targetKey,
  targetLabel,
  validateDraft,
  type ControllerDraft,
  type ControllerDraftErrors,
  type ControllerDraftField,
  type TdsControllerType,
} from '@/lib/tdsControllers';
import { useCaseStore } from '@/store/case';
import { useSessionStore } from '@/store/session';
import { useUiStore } from '@/store/ui';

/**
 * ControllersEditor: the frequency controllers of the next TDS run.
 *
 * A controller reads the frequency while the run goes and sets the power of a
 * battery or another distributed generation device: a droop, in proportion to
 * the deviation, or a fast frequency response, a fixed power delivered once.
 * The substrate runs them (they are numbers, not code); this is where they are
 * set, listed and taken off again.
 *
 * The devices a controller can command come from the substrate
 * (``GET /sessions/{id}/tds/controllers``): the batteries the element builder
 * adds and the distributed generation models of a case file. A case with none
 * says so and where to add one.
 *
 * The list lives in ``useUiStore.tdsConfig.controllers``, which ``RunButton``
 * sends with the run together with the variables that show each controller at
 * work on its device. They name devices of this case, so the case-change
 * cascade empties the list. After a run, each row says what its controller did
 * (``useUiStore.tdsControllerResults``).
 *
 * Test hooks: ``tds-config-controllers``, ``tds-controllers-status``,
 * ``tds-controller-{i}`` with ``-edit`` / ``-remove`` / ``-result``,
 * ``tds-controllers-add``, ``tds-controller-form``, ``tds-controller-type-{type}``,
 * ``tds-controller-target``, ``tds-controller-frequency-{source}``,
 * ``field-tds-controller-{field}``, ``error-tds-controller-{field}``,
 * ``tds-controller-save``, ``tds-controller-cancel``.
 */

// The drawer the form sits in is wide and short: fields and options go side by
// side where they fit and stack where they do not.
const FIELD_GRID = 'grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] items-start gap-2';
const OPTION_GRID = 'grid grid-cols-[repeat(auto-fit,minmax(16rem,1fr))] items-start gap-x-2';

const FREQUENCY_OPTIONS = [
  {
    value: 'coi',
    label: 'System frequency',
    hint: 'The centre of inertia: the speed of the synchronous machines in service, weighted by inertia.',
  },
  {
    value: 'bus',
    label: "At the device's bus",
    hint: 'What the device itself measures. It jumps during a fault, as a real measurement does.',
  },
] as const;

/** How a device reads in the picker: its name, where it is and what it can do. */
function describeTarget(target: TdsControllerTarget): string {
  const parts = [target.bus === null || target.bus === undefined ? null : `bus ${target.bus}`];
  if (typeof target.p_limit === 'number' && target.p_limit < 1e5) {
    parts.push(`up to ${formatNumber(target.p_limit)} MW`);
  }
  if (!target.in_service) parts.push('out of service');
  const detail = parts.filter((part): part is string => part !== null).join(', ');
  return detail === '' ? targetLabel(target) : `${targetLabel(target)} (${detail})`;
}

export function ControllersEditor({ className }: { className?: string }) {
  const sessionId = useSessionStore((s) => s.sessionId);
  const hasCase = useCaseStore((s) => s.selection !== null);
  const controllers = useUiStore((s) => s.tdsConfig.controllers);
  const results = useUiStore((s) => s.tdsControllerResults);
  const setTdsConfig = useUiStore((s) => s.setTdsConfig);

  // ``null``: the form is closed. A number: it edits that row. ``'new'``: it adds one.
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const usable = sessionId !== null && hasCase;

  const remove = (index: number) => {
    setTdsConfig({ controllers: controllers.filter((_, i) => i !== index) });
    setEditing(null);
  };

  return (
    <fieldset
      data-testid="tds-config-controllers"
      className={cn('flex flex-col gap-1.5', className)}
      aria-describedby="tds-config-controllers-hint"
    >
      <legend className="text-muted-foreground text-xs font-medium">
        Frequency control (optional)
      </legend>
      <p
        id="tds-config-controllers-hint"
        className="text-muted-foreground text-[10px] leading-snug"
      >
        A controller reads the frequency while the run goes and sets the power of a battery or a
        distributed generator: a droop, or a fast frequency response. Fixed at run-start. The run
        records what each device was told to add (<code className="font-mono">Pext</code>), its
        current and its state of charge, and the plot lists them under ANDES variables.
      </p>

      {controllers.length > 0 ? (
        <ul className="flex flex-col gap-1" aria-label="Frequency controllers">
          {controllers.map((controller, index) => {
            const result = results?.[index];
            return (
              <li
                key={index}
                data-testid={`tds-controller-${index}`}
                className="border-border/60 flex flex-col gap-0.5 rounded border px-2 py-1"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-foreground min-w-0 text-xs">
                    <span className="font-medium">
                      {CONTROLLER_TYPE_LABELS[controller.spec.type]} on{' '}
                      <span className="font-mono">{targetLabel(controller.spec)}</span>
                    </span>
                    <span className="text-muted-foreground block text-[10px] leading-snug">
                      {describeController(controller.spec)}
                    </span>
                  </span>
                  <span className="flex shrink-0 gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={!usable}
                      onClick={() => setEditing(index)}
                      aria-label={`Edit the ${CONTROLLER_TYPE_LABELS[controller.spec.type]} on ${targetLabel(controller.spec)}`}
                      data-testid={`tds-controller-${index}-edit`}
                    >
                      Edit
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => remove(index)}
                      aria-label={`Remove the ${CONTROLLER_TYPE_LABELS[controller.spec.type]} on ${targetLabel(controller.spec)}`}
                      data-testid={`tds-controller-${index}-remove`}
                    >
                      Remove
                    </Button>
                  </span>
                </div>
                {result !== undefined ? (
                  <span
                    data-testid={`tds-controller-${index}-result`}
                    className="text-foreground text-[10px] leading-snug"
                  >
                    In the last run it {describeResult(result)}.
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {usable ? (
        <ControllerForms
          editing={editing}
          setEditing={setEditing}
          full={controllers.length >= MAX_TDS_CONTROLLERS}
        />
      ) : (
        <p data-testid="tds-controllers-status" className="text-muted-foreground text-[10px]">
          Load a case to add a controller.
        </p>
      )}
    </fieldset>
  );
}

/**
 * The Add button and the form it opens. A separate component so the substrate
 * is only asked for the devices while a session and a case exist to ask about.
 */
function ControllerForms({
  editing,
  setEditing,
  full,
}: {
  editing: number | 'new' | null;
  setEditing: (next: number | 'new' | null) => void;
  full: boolean;
}) {
  const controllers = useUiStore((s) => s.tdsConfig.controllers);
  const setTdsConfig = useUiStore((s) => s.setTdsConfig);
  const list = useTdsControllers();
  const catalogue = list.data;

  let status: string | null = null;
  // First, since the list is asked for again for as long as a run refuses it.
  if (isWaitingForSession(list)) {
    status = 'The session is busy with a run. Controllers can be added when the run ends.';
  } else if (list.isError) {
    status = `Could not list the devices a controller can command: ${list.error.message}`;
  } else if (catalogue === undefined) {
    status = 'Looking for devices a controller can command…';
  } else if (catalogue.targets.length === 0) {
    status =
      'This case has no device a controller can command. Add a battery (ESD1 battery, under Storage in the Add element panel) and it is listed here.';
  }

  if (status !== null || catalogue === undefined) {
    return (
      <p data-testid="tds-controllers-status" className="text-muted-foreground text-[10px]">
        {status}
      </p>
    );
  }

  if (editing === null) {
    return (
      <div className="flex flex-col gap-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={full}
          onClick={() => setEditing('new')}
          data-testid="tds-controllers-add"
          className="self-start"
        >
          Add a controller
        </Button>
        {full ? (
          <span role="alert" className="text-danger text-[10px]">
            A run takes at most {MAX_TDS_CONTROLLERS} controllers.
          </span>
        ) : null}
      </div>
    );
  }

  const existing = editing === 'new' ? undefined : controllers[editing];
  return (
    <ControllerForm
      // A new form for each row, so one row's typing never shows in another's.
      key={String(editing)}
      catalogue={catalogue}
      initial={existing === undefined ? defaultDraft(catalogue) : draftFromSpec(existing.spec)}
      saveLabel={existing === undefined ? 'Add controller' : 'Save controller'}
      onCancel={() => setEditing(null)}
      onSave={(draft, target) => {
        const entry = entryFromDraft(draft, target);
        setTdsConfig({
          controllers:
            existing === undefined
              ? [...controllers, entry]
              : controllers.map((controller, i) => (i === editing ? entry : controller)),
        });
        setEditing(null);
      }}
    />
  );
}

interface ControllerFormProps {
  catalogue: TdsControllerCatalogue;
  initial: ControllerDraft;
  saveLabel: string;
  onSave: (draft: ControllerDraft, target: TdsControllerTarget) => void;
  onCancel: () => void;
}

function ControllerForm({ catalogue, initial, saveLabel, onSave, onCancel }: ControllerFormProps) {
  const [draft, setDraft] = useState<ControllerDraft>(() =>
    // The centre of inertia cannot be read on a case without machines.
    catalogue.coi_available ? initial : { ...initial, frequency: 'bus' },
  );
  // Errors show once the user has tried to save, then follow the typing.
  const [tried, setTried] = useState(false);
  const target = catalogue.targets.find((t) => targetKey(t) === draft.target);
  const check = (): ControllerDraftErrors => ({
    ...validateDraft(draft),
    // A controller being edited may name a device the case no longer has.
    ...(target === undefined ? { target: 'Pick a device' } : {}),
  });
  const errors: ControllerDraftErrors = tried ? check() : {};
  const set = (patch: Partial<ControllerDraft>) => setDraft((d) => ({ ...d, ...patch }));

  const setType = (type: TdsControllerType) => {
    if (type === draft.type) return;
    // The other kind's size starts from the same device's limit.
    const fresh = defaultDraft(catalogue, type, target);
    set({
      type,
      gain: draft.gain === '' ? fresh.gain : draft.gain,
      power: draft.power === '' ? fresh.power : draft.power,
    });
  };

  const save = () => {
    setTried(true);
    if (Object.keys(check()).length > 0 || target === undefined) return;
    onSave(draft, target);
  };

  const field = (name: ControllerDraftField, label: string, hint: string, placeholder?: string) => (
    <NumberField
      name={name}
      label={label}
      hint={hint}
      placeholder={placeholder}
      value={draft[name]}
      error={errors[name]}
      onChange={(text) => set({ [name]: text } as Partial<ControllerDraft>)}
    />
  );

  const limit =
    typeof target?.p_limit === 'number' && target.p_limit < 1e5
      ? `${formatNumber(target.p_limit)} MW`
      : null;
  // A negative power answers a high frequency, and the triggers read that way.
  const absorbing = Number(draft.power) < 0;

  return (
    <div
      data-testid="tds-controller-form"
      className="border-border/60 bg-muted/30 flex flex-col gap-2 rounded border p-2"
    >
      <fieldset className={OPTION_GRID}>
        <legend className="text-muted-foreground text-xs font-medium">Kind</legend>
        {catalogue.types.map((type) => (
          <RadioRow
            key={type}
            name="tds-controller-type"
            testId={`tds-controller-type-${type}`}
            checked={draft.type === type}
            onChange={() => setType(type)}
            label={CONTROLLER_TYPE_LABELS[type]}
            hint={CONTROLLER_TYPE_HINTS[type]}
          />
        ))}
      </fieldset>

      <div className="flex flex-col gap-1">
        <label
          htmlFor="tds-controller-target"
          className="text-muted-foreground text-xs font-medium"
        >
          Device it commands
        </label>
        <select
          id="tds-controller-target"
          data-testid="tds-controller-target"
          value={draft.target}
          aria-invalid={errors.target ? true : undefined}
          onChange={(e) => set({ target: e.target.value })}
          className="bg-background border-border h-7 max-w-full rounded border px-2 font-mono text-xs"
        >
          <option value="" disabled>
            Pick a device…
          </option>
          {catalogue.targets.map((t) => (
            <option key={targetKey(t)} value={targetKey(t)}>
              {describeTarget(t)}
            </option>
          ))}
        </select>
        {errors.target ? (
          <span
            role="alert"
            data-testid="error-tds-controller-target"
            className="text-danger text-[10px]"
          >
            {errors.target}
          </span>
        ) : null}
        {target !== undefined && !target.in_service ? (
          <span className="text-muted-foreground text-[10px] leading-snug">
            This device is out of service, so a command does nothing to it.
          </span>
        ) : null}
      </div>

      <fieldset className={OPTION_GRID}>
        <legend className="text-muted-foreground text-xs font-medium">Frequency it reads</legend>
        {FREQUENCY_OPTIONS.map((option) => {
          const unavailable = option.value === 'coi' && !catalogue.coi_available;
          return (
            <RadioRow
              key={option.value}
              name="tds-controller-frequency"
              testId={`tds-controller-frequency-${option.value}`}
              checked={draft.frequency === option.value}
              disabled={unavailable}
              onChange={() => set({ frequency: option.value })}
              label={option.label}
              hint={
                unavailable
                  ? 'Not available: this case has no synchronous machine to read it from.'
                  : option.hint
              }
            />
          );
        })}
      </fieldset>

      {draft.type === 'droop' ? (
        <div className={FIELD_GRID}>
          {field('gain', 'Gain (MW per Hz)', 'Power commanded for each Hz beyond the dead band.')}
          {field(
            'deadband',
            'Dead band (Hz)',
            'Deviation from nominal, either way, that it ignores. 0 for none.',
          )}
          {field(
            'pMax',
            'Largest command (MW, optional)',
            limit === null
              ? "Either way. Leave blank for the device's own limit."
              : `Either way. Leave blank for the device's own limit, ${limit}.`,
            limit ?? 'device limit',
          )}
        </div>
      ) : (
        <div className={FIELD_GRID}>
          {field(
            'power',
            'Power (MW)',
            limit === null
              ? 'Commanded once triggered. Negative absorbs, and then waits for a high frequency.'
              : `Commanded once triggered; the device delivers up to ${limit}. Negative absorbs, and then waits for a high frequency.`,
          )}
          {field(
            'triggerDeviation',
            'Trigger: deviation (Hz)',
            `It fires when the frequency is this far ${absorbing ? 'above' : 'below'} nominal. Blank to use the rate alone.`,
          )}
          {field(
            'triggerRocof',
            'Trigger: rate of change (Hz/s, optional)',
            `It also fires when the frequency ${absorbing ? 'rises' : 'falls'} this fast, measured from one sample to the next.`,
            'not used',
          )}
          {field(
            'hold',
            'Hold (s)',
            'How long it holds the power before it lets go. It fires once.',
          )}
        </div>
      )}

      <details data-testid="tds-controller-advanced">
        <summary
          className={cn(
            'text-muted-foreground hover:text-foreground cursor-pointer text-xs font-medium',
            'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
          )}
        >
          Timing and ramp
        </summary>
        <div className={cn('mt-2', FIELD_GRID)}>
          {field(
            'period',
            'Sample period (s)',
            'It reads the frequency and sets its command this often, and holds it in between.',
          )}
          {field('tStart', 'Start time (s)', 'It commands nothing before this time of the run.')}
          {field(
            'ramp',
            'Ramp limit (MW/s, optional)',
            'The most the command changes in a second. Blank lets it jump.',
            'no limit',
          )}
        </div>
      </details>

      <div className="flex gap-2">
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={save}
          data-testid="tds-controller-save"
        >
          {saveLabel}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
          data-testid="tds-controller-cancel"
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

function RadioRow({
  name,
  testId,
  checked,
  disabled,
  onChange,
  label,
  hint,
}: {
  name: string;
  testId: string;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  label: string;
  hint: string;
}): ReactNode {
  return (
    <label
      htmlFor={testId}
      className={cn(
        'flex items-start gap-2 rounded px-1 py-1',
        disabled ? 'opacity-60' : 'hover:bg-muted/40 cursor-pointer transition-colors',
      )}
    >
      <input
        id={testId}
        data-testid={testId}
        type="radio"
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        className={cn(
          'border-border mt-0.5 h-3.5 w-3.5 border',
          'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
        )}
      />
      <span className="flex flex-col">
        <span className="text-foreground text-xs">{label}</span>
        <span className="text-muted-foreground text-[10px] leading-snug">{hint}</span>
      </span>
    </label>
  );
}

function NumberField({
  name,
  label,
  hint,
  placeholder,
  value,
  error,
  onChange,
}: {
  name: ControllerDraftField;
  label: string;
  hint: string;
  placeholder?: string;
  value: string;
  error?: string;
  onChange: (next: string) => void;
}): ReactNode {
  const id = `tds-controller-${name}`;
  const describedBy = [`${id}-hint`, error ? `${id}-error` : null].filter(Boolean).join(' ');
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-muted-foreground text-xs font-medium">
        {label}
      </label>
      <Input
        id={id}
        data-testid={`field-${id}`}
        inputMode="decimal"
        value={value}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        onChange={onChange}
        className={cn('h-7 font-mono text-xs', error ? 'border-danger' : '')}
      />
      <span id={`${id}-hint`} className="text-muted-foreground text-[10px] leading-snug">
        {hint}
      </span>
      {error ? (
        <span
          id={`${id}-error`}
          role="alert"
          data-testid={`error-${id}`}
          className="text-danger text-[10px]"
        >
          {error}
        </span>
      ) : null}
    </div>
  );
}
