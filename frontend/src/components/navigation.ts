import {
  Activity,
  Server,
  Key,
  GitFork,
  DollarSign,
  Lock,
  MessageSquare,
  History,
  FileText,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
}

export interface NavSection {
  id: string;
  label: string;
  items: NavItem[];
}

// DECISION: The rail groups destinations by the job the operator is doing, but keeps the
// order they already learned from the old top bar. Overview → Configure → Access → Observe
// also mirrors the lifecycle of a request: add providers, pool them, issue tokens, watch traffic.
export const NAV_SECTIONS: NavSection[] = [
  {
    id: 'overview',
    label: 'Overview',
    items: [{ id: 'dashboard', label: 'Dashboard', icon: Activity }],
  },
  {
    id: 'configure',
    label: 'Configure',
    items: [
      { id: 'providers', label: 'Providers & Wizard', icon: Server },
      { id: 'keys', label: 'Upstream Keys', icon: Key },
      { id: 'routing', label: 'AI Pools', icon: GitFork },
      { id: 'pricing', label: 'Model Pricing', icon: DollarSign },
    ],
  },
  {
    id: 'access',
    label: 'Access',
    items: [
      { id: 'gateway', label: 'Gateway Keys', icon: Lock },
      { id: 'playground', label: 'Playground', icon: MessageSquare },
    ],
  },
  {
    id: 'observe',
    label: 'Observe',
    items: [
      { id: 'history', label: 'History', icon: History },
      { id: 'logs', label: 'Request Logs', icon: FileText },
    ],
  },
];

export const NAV_ITEMS = NAV_SECTIONS.flatMap((section) => section.items);

export function findNavItem(id: string): NavItem | undefined {
  return NAV_ITEMS.find((item) => item.id === id);
}

export function findNavSection(id: string): NavSection | undefined {
  return NAV_SECTIONS.find((section) => section.items.some((item) => item.id === id));
}
