import type { ComponentProps } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { DashboardStats } from '../types';
import { Sidebar } from './Sidebar';

const stats: DashboardStats = {
  totalRequests: 120,
  successRequests: 117,
  errorRequests: 3,
  successRate: 97.5,
  avgLatencyMs: 640,
  p50LatencyMs: 410,
  p95LatencyMs: 1800,
  totalPromptTokens: 1000,
  totalCompletionTokens: 2000,
  totalKeys: 5,
  activeKeys: 3,
  totalProviders: 4,
  circuits: { closed: 4, halfOpen: 0, open: 1 },
};

const renderSidebar = (overrides: Partial<ComponentProps<typeof Sidebar>> = {}) => {
  const props: ComponentProps<typeof Sidebar> = {
    activeTab: 'dashboard',
    onNavigate: () => {},
    onClose: () => {},
    open: false,
    stats: null,
    ...overrides,
  };
  return render(<Sidebar {...props} />);
};

describe('Sidebar', () => {
  it('exposes every console destination in the navigation landmark', () => {
    renderSidebar();

    expect(screen.getByRole('navigation', { name: 'Console sections' })).toBeInTheDocument();
    for (const label of [
      'Dashboard',
      'Providers & Wizard',
      'Upstream Keys',
      'AI Pools',
      'Model Pricing',
      'Gateway Keys',
      'Playground',
      'History',
      'Request Logs',
    ]) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('marks only the active destination with aria-current', () => {
    renderSidebar({ activeTab: 'logs' });

    expect(screen.getByRole('button', { name: 'Request Logs' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Dashboard' })).not.toHaveAttribute('aria-current');
  });

  it('navigates to the chosen destination', async () => {
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    renderSidebar({ onNavigate });

    await user.click(screen.getByRole('button', { name: 'Playground' }));

    expect(onNavigate).toHaveBeenCalledWith('playground');
  });

  it('closes the open drawer on Escape and focuses the current page first', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderSidebar({ open: true, onClose });

    expect(screen.getByRole('button', { name: 'Dashboard' })).toHaveFocus();

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders live stats and the environment note in the rail footer', () => {
    renderSidebar({ stats });

    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('/ 5')).toBeInTheDocument();
    expect(screen.getByText('97.5%')).toBeInTheDocument();
    expect(screen.getByText(/Self-hosted/)).toBeInTheDocument();
  });
});
