/**
 * ModelDocDialog: the catalogue of the models ANDES ships, searchable, and
 * ANDES's own documentation of the one that is picked or named, as plain text
 * and never as HTML.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProblemDetailsError } from '@/api/client';
import type { components } from '@/api/generated';
import { ModelDocDialog } from '@/components/models/ModelDocDialog';
import { useModelDocStore } from '@/store/modelDoc';

type ModelDoc = components['schemas']['ModelDoc'];
type SupportedModels = components['schemas']['SupportedModels'];

type DocResult = {
  isPending: boolean;
  isError: boolean;
  error: Error | null;
  data: ModelDoc | undefined;
};
type ListResult = {
  isPending: boolean;
  isError: boolean;
  error: Error | null;
  data: SupportedModels | undefined;
};

const GROUPS: SupportedModels = {
  groups: {
    ACNode: ['Bus'],
    SynGen: ['GENROU', 'GENCLS'],
    TurbineGov: ['TGOV1', 'TG2'],
  },
};

/** The text the server answers for a model, distinct for each model. */
function textOf(model: string): string {
  return `${model}\n======\nThe documentation of ${model}.\n\nParameters:\n  Sn   rated power`;
}

let listResult: ListResult;
/** What the doc query answers, by model; a model not listed gets its own text. */
let docResults: Record<string, DocResult>;
let docCalls: Array<string | null>;

vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useSupportedModels: () => listResult,
    useModelDoc: (model: string | null) => {
      docCalls.push(model);
      // A query with no model is disabled, which TanStack reports as pending.
      if (model === null) return pendingDoc();
      return docResults[model] ?? docOf({ model, doc: textOf(model) });
    },
  };
});

function pendingDoc(): DocResult {
  return { isPending: true, isError: false, error: null, data: undefined };
}

function docOf(data: ModelDoc): DocResult {
  return { isPending: false, isError: false, error: null, data };
}

function docError(error: Error): DocResult {
  return { isPending: false, isError: true, error, data: undefined };
}

function listError(error: Error): ListResult {
  return { isPending: false, isError: true, error, data: undefined };
}

function problem(status: number, title: string): ProblemDetailsError {
  return new ProblemDetailsError({
    type: 'about:blank',
    title,
    status,
    detail: null,
    instance: null,
  });
}

/** The 409 of a session that stayed busy through every retry. */
function busy(): ProblemDetailsError {
  const body = {
    type: 'about:blank',
    title: 'Conflict',
    status: 409,
    detail: 'session is busy with an in-flight operation',
    instance: null,
    recovery: { kind: 'wait-for-job' as const, label: 'Wait for the running operation' },
  };
  return new ProblemDetailsError(body, body);
}

function openDialog(model: string | null) {
  useModelDocStore.setState({ dialogOpen: true, model });
}

const shownText = () => screen.getByTestId('model-doc-text').textContent;

beforeEach(() => {
  listResult = { isPending: false, isError: false, error: null, data: GROUPS };
  docResults = {};
  docCalls = [];
});

afterEach(() => {
  useModelDocStore.setState({ dialogOpen: false, model: null });
});

describe('<ModelDocDialog /> browse mode', () => {
  it('lists every model under its group, in the order the server sent, with a search box', () => {
    openDialog(null);
    render(<ModelDocDialog />);
    expect(screen.getByTestId('model-doc-title')).toHaveTextContent('Model documentation');
    expect(screen.getByRole('textbox', { name: 'Search models' })).toHaveAttribute(
      'placeholder',
      'Search models…',
    );
    const list = screen.getByTestId('model-doc-list');
    expect(
      within(list)
        .getAllByRole('heading')
        .map((h) => h.textContent),
    ).toEqual(['ACNode', 'SynGen', 'TurbineGov']);
    expect(
      within(list)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Bus', 'GENROU', 'GENCLS', 'TGOV1', 'TG2']);
  });

  it('shows the first model of the first group before anything is picked, and marks it', () => {
    openDialog(null);
    render(<ModelDocDialog />);
    expect(shownText()).toBe(textOf('Bus'));
    expect(screen.getByTestId('model-doc-item-Bus')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('model-doc-item-GENROU')).toHaveAttribute('aria-pressed', 'false');
  });

  it('filters the models by what is typed, case-insensitive, and drops empty groups', async () => {
    const user = userEvent.setup();
    openDialog(null);
    render(<ModelDocDialog />);
    await user.type(screen.getByRole('textbox', { name: 'Search models' }), 'gEn');
    const list = screen.getByTestId('model-doc-list');
    expect(
      within(list)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['GENROU', 'GENCLS']);
    expect(
      within(list)
        .getAllByRole('heading')
        .map((h) => h.textContent),
    ).toEqual(['SynGen']);
    // Nothing was picked, so the first model the list shows is the one shown.
    expect(shownText()).toBe(textOf('GENROU'));
  });

  it('matches the name only, not the group it is in', async () => {
    const user = userEvent.setup();
    openDialog(null);
    render(<ModelDocDialog />);
    await user.type(screen.getByRole('textbox', { name: 'Search models' }), 'syngen');
    expect(screen.getByText('No model matches.')).toBeInTheDocument();
    expect(screen.queryByTestId('model-doc-item-GENROU')).toBeNull();
  });

  it('says so when nothing matches, and shows no documentation', async () => {
    const user = userEvent.setup();
    openDialog(null);
    render(<ModelDocDialog />);
    await user.type(screen.getByRole('textbox', { name: 'Search models' }), 'zzz');
    expect(screen.getByText('No model matches.')).toBeInTheDocument();
    expect(screen.queryByTestId('model-doc-item-GENROU')).toBeNull();
    expect(screen.queryByTestId('model-doc-text')).toBeNull();
    expect(screen.queryByText('Loading documentation…')).toBeNull();
  });

  it('shows the documentation of each model as it is clicked, never the one before', async () => {
    const user = userEvent.setup();
    openDialog(null);
    render(<ModelDocDialog />);
    await user.click(screen.getByTestId('model-doc-item-GENROU'));
    const text = screen.getByTestId('model-doc-text');
    expect(text.tagName).toBe('PRE');
    expect(text.textContent).toBe(textOf('GENROU'));
    expect(screen.getByTestId('model-doc-item-GENROU')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('model-doc-item-Bus')).toHaveAttribute('aria-pressed', 'false');

    await user.click(screen.getByTestId('model-doc-item-TG2'));
    expect(shownText()).toBe(textOf('TG2'));
    expect(docCalls.at(-1)).toBe('TG2');
  });

  it('keeps the model picked while the search hides it', async () => {
    const user = userEvent.setup();
    openDialog(null);
    render(<ModelDocDialog />);
    await user.click(screen.getByTestId('model-doc-item-TGOV1'));
    await user.type(screen.getByRole('textbox', { name: 'Search models' }), 'gen');
    expect(shownText()).toBe(textOf('TGOV1'));
  });

  it('starts afresh when it is opened again: the search empty and nothing picked', async () => {
    const user = userEvent.setup();
    openDialog(null);
    render(<ModelDocDialog />);
    await user.click(screen.getByTestId('model-doc-item-TG2'));
    await user.type(screen.getByRole('textbox', { name: 'Search models' }), 'tg');
    act(() => useModelDocStore.getState().closeDialog());
    expect(screen.queryByTestId('model-doc-dialog')).toBeNull();
    act(() => useModelDocStore.getState().openDialog());
    expect(screen.getByRole('textbox', { name: 'Search models' })).toHaveValue('');
    expect(screen.getByTestId('model-doc-item-Bus')).toBeInTheDocument();
    expect(shownText()).toBe(textOf('Bus'));
  });

  it('says while the list is loading, and shows no documentation yet', () => {
    listResult = { isPending: true, isError: false, error: null, data: undefined };
    openDialog(null);
    render(<ModelDocDialog />);
    expect(screen.getByText('Loading models…')).toBeInTheDocument();
    expect(screen.queryByText('Loading documentation…')).toBeNull();
  });

  it('says when the list could not be loaded, and asks for no documentation', () => {
    listResult = listError(new Error('down'));
    openDialog(null);
    render(<ModelDocDialog />);
    const error = screen.getByTestId('model-doc-list-error');
    expect(error).toHaveTextContent('The model list could not be loaded.');
    expect(error).toHaveAttribute('role', 'alert');
    expect(docCalls.every((m) => m === null)).toBe(true);
    expect(screen.queryByText('Loading documentation…')).toBeNull();
  });

  it('says when the session runs an engine that documents no models (409)', () => {
    listResult = listError(problem(409, 'Conflict'));
    openDialog(null);
    render(<ModelDocDialog />);
    expect(screen.getByTestId('model-doc-list-error')).toHaveTextContent(
      'Only ANDES documents its models, and this session runs another engine.',
    );
  });
});

describe('<ModelDocDialog /> direct mode', () => {
  it('names the model, has no list, and shows its documentation', () => {
    openDialog('GENROU');
    render(<ModelDocDialog />);
    expect(screen.getByTestId('model-doc-title')).toHaveTextContent('Model documentation GENROU');
    expect(screen.queryByTestId('model-doc-list')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(docCalls).toEqual(['GENROU']);
    expect(shownText()).toBe(textOf('GENROU'));
    expect(screen.getByRole('region', { name: 'Documentation of GENROU' })).toHaveAttribute(
      'tabindex',
      '0',
    );
  });

  it('shows the model it is opened for next, not the one before', () => {
    openDialog('GENROU');
    render(<ModelDocDialog />);
    expect(shownText()).toBe(textOf('GENROU'));
    act(() => useModelDocStore.getState().closeDialog());
    act(() => useModelDocStore.getState().openDialog('TGOV1'));
    expect(screen.getByTestId('model-doc-title')).toHaveTextContent('TGOV1');
    expect(shownText()).toBe(textOf('TGOV1'));
  });

  it('says while the documentation is loading', () => {
    docResults = { GENROU: pendingDoc() };
    openDialog('GENROU');
    render(<ModelDocDialog />);
    expect(screen.getByText('Loading documentation…')).toBeInTheDocument();
    expect(screen.queryByTestId('model-doc-text')).toBeNull();
  });

  it('has its own plain state for a model ANDES does not have (404)', () => {
    docResults = { NO_SUCH: docError(problem(404, 'Not Found')) };
    openDialog('NO_SUCH');
    render(<ModelDocDialog />);
    const notFound = screen.getByTestId('model-doc-not-found');
    expect(notFound).toHaveTextContent('ANDES has no model with this name.');
    expect(notFound).toHaveAttribute('role', 'alert');
    expect(screen.queryByTestId('model-doc-error')).toBeNull();
    expect(screen.queryByTestId('model-doc-text')).toBeNull();
  });

  it('says another engine documents no models (409)', () => {
    docResults = { GENROU: docError(problem(409, 'Conflict')) };
    openDialog('GENROU');
    render(<ModelDocDialog />);
    expect(screen.getByTestId('model-doc-other-engine')).toHaveTextContent(
      'Only ANDES documents its models, and this session runs another engine.',
    );
    expect(screen.queryByTestId('model-doc-error')).toBeNull();
  });

  it('says a session that stayed busy is busy, not that it runs another engine', () => {
    docResults = { GENROU: docError(busy()) };
    openDialog('GENROU');
    const view = render(<ModelDocDialog />);
    expect(screen.queryByTestId('model-doc-other-engine')).toBeNull();
    expect(screen.getByTestId('model-doc-error')).toHaveTextContent(
      'The documentation could not be loaded. The session is busy with another operation; open it again once that is done.',
    );
    view.unmount();

    listResult = listError(busy());
    openDialog(null);
    render(<ModelDocDialog />);
    expect(screen.getByTestId('model-doc-list-error')).toHaveTextContent(
      'The model list could not be loaded. The session is busy with another operation',
    );
  });

  it('says the documentation could not be loaded for any other failure', () => {
    docResults = { GENROU: docError(problem(422, 'Unprocessable')) };
    openDialog('GENROU');
    const view = render(<ModelDocDialog />);
    const error = screen.getByTestId('model-doc-error');
    expect(error).toHaveTextContent('The documentation could not be loaded.');
    expect(error).toHaveAttribute('role', 'alert');
    expect(screen.queryByTestId('model-doc-not-found')).toBeNull();
    expect(screen.queryByTestId('model-doc-text')).toBeNull();
    view.unmount();

    docResults = { GENROU: docError(new Error('network down')) };
    openDialog('GENROU');
    render(<ModelDocDialog />);
    expect(screen.getByTestId('model-doc-error')).toBeInTheDocument();
  });

  it('renders the text as text: markup in it is shown, not parsed', () => {
    const raw = 'GENROU\n<b>not bold</b>\n<img src=x onerror="alert(1)">\nParameters:';
    docResults = { GENROU: docOf({ model: 'GENROU', doc: raw }) };
    openDialog('GENROU');
    render(<ModelDocDialog />);
    const text = screen.getByTestId('model-doc-text');
    expect(text.textContent).toBe(raw);
    const dialog = screen.getByTestId('model-doc-dialog');
    expect(dialog.querySelector('b')).toBeNull();
    expect(dialog.querySelector('img')).toBeNull();
  });

  it('keeps the spaces and line breaks of the text, in a fixed-width block', () => {
    const raw = 'Parameters\n\n Name |  Description  | Default\n------+---------------+--------';
    docResults = { GENROU: docOf({ model: 'GENROU', doc: raw }) };
    openDialog('GENROU');
    render(<ModelDocDialog />);
    const text = screen.getByTestId('model-doc-text');
    expect(text.textContent).toBe(raw);
    expect(text).toHaveClass('whitespace-pre', 'font-mono', 'overflow-auto');
  });
});

describe('<ModelDocDialog /> closing', () => {
  it('tells the store when the dialog is dismissed', async () => {
    const user = userEvent.setup();
    openDialog('GENROU');
    render(<ModelDocDialog />);
    expect(screen.getByTestId('model-doc-dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(useModelDocStore.getState().dialogOpen).toBe(false);
  });

  it('closes by its Close button, and gives the keyboard back to what opened it', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button" onClick={() => useModelDocStore.getState().openDialog('GENROU')}>
          Opener
        </button>
        <ModelDocDialog />
      </>,
    );
    const opener = screen.getByRole('button', { name: 'Opener' });
    opener.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('model-doc-dialog')).toBeInTheDocument();
    expect(opener).not.toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(useModelDocStore.getState().dialogOpen).toBe(false);
    expect(screen.queryByTestId('model-doc-dialog')).toBeNull();
    await waitFor(() => expect(opener).toHaveFocus());
  });
});
