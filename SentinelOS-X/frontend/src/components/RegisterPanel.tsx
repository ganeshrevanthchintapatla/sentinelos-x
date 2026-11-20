import { useState } from 'react';
import { UserPlus } from 'lucide-react';
import { useAction } from '../hooks/useAction';
import { useSentinel } from '../hooks/useSentinelData';

export function RegisterPanel() {
  const { responders } = useSentinel();
  const { run, pending } = useAction();
  const [name, setName] = useState('');
  const firstUser = !responders.some(r => r.role === 'incident_commander');

  return (
    <form
      className="panel flex flex-wrap items-end gap-4 border-slate-600 p-5"
      onSubmit={e => {
        e.preventDefault();
        void run('register', c => c.reducers.registerResponder({ displayName: name }), 'Joined the response team');
      }}
    >
      <div className="min-w-60 flex-1">
        <label htmlFor="reg-name" className="text-base font-semibold text-slate-50">
          Join the response team
        </label>
        <p className="mt-0.5 mb-3 text-sm text-slate-400">
          {firstUser
            ? 'You are the first person here, so you become Incident Commander and can add everyone else.'
            : 'You join as an Observer. An Incident Commander gives you a role in People & access.'}
        </p>
        <input id="reg-name" className="input max-w-sm" value={name} onChange={e => setName(e.target.value)} placeholder="Your name as the team knows it" minLength={2} maxLength={40} required />
      </div>
      <button className="btn-primary" disabled={pending === 'register' || name.trim().length < 2}>
        <UserPlus className="size-4" aria-hidden /> Join team
      </button>
    </form>
  );
}
