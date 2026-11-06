import { createRef, type ComponentProps } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TopBar } from './TopBar';

const renderTopBar = (overrides: Partial<ComponentProps<typeof TopBar>> = {}) => {
  const props: ComponentProps<typeof TopBar> = {
    activeTab: 'dashboard',
    navOpen: false,
    menuButtonRef: createRef<HTMLButtonElement>(),
    onOpenNav: () => {},
    onRefresh: () => {},
    stats: null,
    lastUpdated: null,
    isStale: false,
    ...overrides,
  };
  return render(<TopBar {...props} />);
};

describe('TopBar', () => {
  it('names the current section and page in the breadcrumb', () => {
    renderTopBar({ activeTab: 'logs' });

    const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(breadcrumb).toHaveTextContent('Observe');
    expect(breadcrumb).toHaveTextContent('Request Logs');
  });

  it('shows the last refresh time', () => {
    renderTopBar({ lastUpdated: new Date('2026-11-06T04:02:31') });

    expect(screen.getByText(/^Updated /)).toBeInTheDocument();
  });

  it('reports a stale connection instead of a timestamp', () => {
    renderTopBar({ isStale: true, lastUpdated: new Date('2026-11-06T04:02:31') });

    expect(screen.getByText('Reconnecting…')).toBeInTheDocument();
    expect(screen.queryByText(/^Updated /)).not.toBeInTheDocument();
  });

  it('opens the navigation drawer and requests a refresh', async () => {
    const onOpenNav = vi.fn();
    const onRefresh = vi.fn();
    const user = userEvent.setup();
    renderTopBar({ onOpenNav, onRefresh });

    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    await user.click(screen.getByRole('button', { name: 'Refresh data' }));

    expect(onOpenNav).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
