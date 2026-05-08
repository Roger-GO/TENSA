import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

function Harness() {
  return (
    <Tabs defaultValue="properties">
      <TabsList>
        <TabsTrigger value="properties">Properties</TabsTrigger>
        <TabsTrigger value="results">Results</TabsTrigger>
      </TabsList>
      <TabsContent value="properties">Property panel content</TabsContent>
      <TabsContent value="results">Results panel content</TabsContent>
    </Tabs>
  );
}

describe('Tabs', () => {
  it('renders default-selected tab content', () => {
    render(<Harness />);
    expect(screen.getByText('Property panel content')).toBeInTheDocument();
    expect(screen.queryByText('Results panel content')).not.toBeInTheDocument();
  });

  it('clicking another tab swaps panels', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('tab', { name: 'Results' }));
    expect(screen.getByText('Results panel content')).toBeInTheDocument();
    expect(screen.queryByText('Property panel content')).not.toBeInTheDocument();
  });

  it('arrow keys cycle through tabs', async () => {
    render(<Harness />);
    const propertiesTab = screen.getByRole('tab', { name: 'Properties' });
    propertiesTab.focus();
    expect(propertiesTab).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    const resultsTab = screen.getByRole('tab', { name: 'Results' });
    expect(resultsTab).toHaveFocus();
    expect(screen.getByText('Results panel content')).toBeInTheDocument();
  });

  it('renders tab triggers with selected state attribute', () => {
    render(<Harness />);
    const propertiesTab = screen.getByRole('tab', { name: 'Properties' });
    const resultsTab = screen.getByRole('tab', { name: 'Results' });
    expect(propertiesTab).toHaveAttribute('data-state', 'active');
    expect(resultsTab).toHaveAttribute('data-state', 'inactive');
  });
});
