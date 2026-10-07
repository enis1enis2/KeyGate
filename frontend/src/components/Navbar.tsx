import React from 'react';
import { 
  ShieldCheck, 
  Activity, 
  Server, 
  Key, 
  GitFork, 
  Lock, 
  FileText,
  Radio,
  DollarSign
} from 'lucide-react';
import type { DashboardStats } from '../types';

interface NavbarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  stats: DashboardStats | null;
}

export const Navbar: React.FC<NavbarProps> = ({ activeTab, setActiveTab, stats }) => {
  const tabs = [
    { id: 'dashboard', label: 'Dashboard', icon: Activity },
    { id: 'providers', label: 'Providers & Wizard', icon: Server },
    { id: 'keys', label: 'Upstream Keys', icon: Key },
    { id: 'routing', label: 'AI Pools', icon: GitFork },
    { id: 'pricing', label: 'Model Pricing', icon: DollarSign },
    { id: 'gateway', label: 'Gateway Keys', icon: Lock },
    { id: 'logs', label: 'Request Logs', icon: FileText },
  ];

  return (
    <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-500 flex items-center justify-center shadow-lg shadow-indigo-500/20">
              <ShieldCheck className="w-6 h-6 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-lg text-white tracking-tight">KeyGate</span>
                <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center gap-1">
                  <Radio className="w-3 h-3 animate-pulse" /> Live
                </span>
              </div>
              <p className="text-xs text-slate-400">Resilient Upstream Key Pool & AI Gateway</p>
            </div>
          </div>

          {/* Navigation Links */}
          <nav className="flex space-x-1">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                    isActive
                      ? 'bg-indigo-600 text-white shadow-md shadow-indigo-500/20'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  {tab.label}
                </button>
              );
            })}
          </nav>

          {/* Quick Status Pill */}
          <div className="hidden lg:flex items-center gap-4 text-xs font-mono text-slate-400">
            <div className="bg-slate-800/80 px-3 py-1.5 rounded-lg border border-slate-700/60 flex items-center gap-2">
              <span className="text-slate-500">Active Keys:</span>
              <span className="text-emerald-400 font-semibold">{stats?.activeKeys ?? 0}</span>
              <span className="text-slate-600">/</span>
              <span className="text-slate-300">{stats?.totalKeys ?? 0}</span>
            </div>
            <div className="bg-slate-800/80 px-3 py-1.5 rounded-lg border border-slate-700/60 flex items-center gap-2">
              <span className="text-slate-500">24h SR:</span>
              <span className={`font-semibold ${
                (stats?.successRate ?? 100) >= 95 ? 'text-emerald-400' : 'text-amber-400'
              }`}>
                {stats?.successRate ?? 100}%
              </span>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
};
