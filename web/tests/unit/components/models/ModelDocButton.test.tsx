/**
 * ModelDocButton: the small control beside a model's name that opens the
 * Model documentation dialog on that model through the store flag.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModelDocButton } from '@/components/models/ModelDocButton';
import { useModelDocStore } from '@/store/modelDoc';

afterEach(() => {
  useModelDocStore.setState({ dialogOpen: false, model: null });
});

describe('<ModelDocButton />', () => {
  it('is named for the model it documents, and opens the dialog on it', async () => {
    const user = userEvent.setup();
    render(<ModelDocButton model="GENROU" />);
    const button = screen.getByRole('button', { name: 'Model documentation for GENROU' });
    expect(button).toHaveAttribute('data-testid', 'model-doc-open');
    expect(button).toHaveAttribute('title', 'Model documentation');
    expect(useModelDocStore.getState()).toMatchObject({ dialogOpen: false, model: null });

    await user.click(button);
    expect(useModelDocStore.getState()).toMatchObject({ dialogOpen: true, model: 'GENROU' });
  });
});
