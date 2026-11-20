// Layout for the autonomous demo. Same sidebar and header styling as AppShell, but it
// reads nothing from SpacetimeDB, so it works while that server is down.
import { NavLink, Outlet } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { FLAT_NAV, NAV, SidebarBrand } from './AppShell';
import { DEMO_URL } from '../hooks/useDemoStream';

export function DemoShell() {
  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-ink-700 bg-ink-900 md:flex">
        <SidebarBrand />
        <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-2" aria-label="Main">
          {NAV.map(g => (
            <div key={g.group}>
              <div className="px-2.5 pb-1.5 text-xs text-slate-500">{g.group}</div>
              <ul className="space-y-0.5">
                {g.items.map(n => (
                  <li key={n.to}>
                    <NavLink
                      to={n.to}
                      end={n.end}
                      className={({ isActive: a }) =>
                        `relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors ${a ? 'bg-ink-800 font-medium text-slate-50 before:absolute before:top-2 before:bottom-2 before:-left-3 before:w-0.5 before:rounded-full before:bg-slate-200' : 'text-slate-400 hover:bg-ink-850 hover:text-slate-200'}`
                      }
                    >
                      <n.icon className="size-4 shrink-0" aria-hidden />
                      <span className="flex-1">{n.label}</span>
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="space-y-1.5 border-t border-ink-700 px-5 py-4 text-xs text-slate-500">
          <div className="flex items-center gap-1.5 text-slate-300">
            <ShieldCheck className="size-3.5 text-emerald-400" aria-hidden /> Demo engine
          </div>
          <p className="leading-relaxed">
            This page reads from <span className="ident text-[11px]">{DEMO_URL.replace(/^https?:\/\//, '')}</span>, not from SpacetimeDB.
          </p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-4 border-b border-ink-700 bg-ink-900 px-4 lg:px-6">
          <nav className="flex gap-0.5 md:hidden" aria-label="Main (mobile)">
            {FLAT_NAV.map(n => (
              <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive: a }) => `rounded-md p-2 ${a ? 'bg-ink-800 text-slate-50' : 'text-slate-400'}`} aria-label={n.label}>
                <n.icon className="size-4" />
              </NavLink>
            ))}
          </nav>
          <div className="hidden min-w-0 flex-1 items-center gap-2 text-[13px] text-slate-400 md:flex">
            <ShieldCheck className="size-4 text-emerald-400" aria-hidden />
            Autonomous demo. Real sensor, simulated servers.
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 lg:px-8">
          <div className="mx-auto max-w-[1680px]">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
