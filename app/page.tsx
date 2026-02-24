'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Phase = 'idle' | 'routing';

export default function ConsoleLauncherPage() {
  const router = useRouter();
  const [input, setInput] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [target, setTarget] = useState<'dev' | 'invest' | null>(null);
  const [logs, setLogs] = useState<string[]>([
    'console.log launcher initialized.',
    'type: dev | invest | help',
  ]);

  const runCommand = (raw: string) => {
    const cmd = raw.trim().toLowerCase();
    const normalized = cmd.replace('console.log(', '').replace(')', '').replace(/[\'"`]/g, '').trim();

    setLogs((prev) => [...prev, `> ${raw}`]);

    if (!normalized) return;
    if (normalized === 'help') {
      setLogs((prev) => [...prev, 'available: dev | invest']);
      return;
    }

    if (normalized === 'dev' || normalized === 'invest') {
      setTarget(normalized);
      setLogs((prev) => [...prev, `routing to console.log(${normalized}) ...`]);
      setPhase('routing');
      setTimeout(() => router.push(`/${normalized}`), 620);
      return;
    }

    setLogs((prev) => [...prev, `unknown command: ${raw}`]);
  };

  return (
    <div className="relative">
      <div
        className={`transition-all duration-500 ${phase === 'routing' ? 'opacity-0 -translate-y-3 scale-[0.985]' : 'opacity-100 translate-y-0 scale-100'}`}
      >
        <div className="mx-auto max-w-3xl rounded-2xl border p-6 md:p-8" style={{ borderColor: 'var(--border)', backgroundColor: '#0b0f17' }}>
          <div className="mb-5">
            <h1 className="text-2xl md:text-3xl font-extrabold" style={{ color: 'var(--text)' }}>console.log()</h1>
            <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>종구리의 멀티 모드 런처 · dev / invest</p>
          </div>

          <div className="rounded-xl border p-4 h-[320px] overflow-auto text-sm font-mono" style={{ borderColor: 'var(--border)', backgroundColor: '#070b11', color: '#d1e3ff' }}>
            {logs.map((line, idx) => (
              <div key={`${line}-${idx}`} className="leading-6">{line}</div>
            ))}
          </div>

          <form
            className="mt-4 flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!input.trim() || phase === 'routing') return;
              const raw = input;
              setInput('');
              runCommand(raw);
            }}
          >
            <span className="text-sm font-mono" style={{ color: 'var(--accent)' }}>{'>'}</span>
            <input
              autoFocus
              disabled={phase === 'routing'}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="dev 또는 invest 입력"
              className="flex-1 rounded-lg border px-3 py-2 text-sm font-mono outline-none"
              style={{ borderColor: 'var(--border)', backgroundColor: '#0b111b', color: 'var(--text)' }}
            />
            <button
              type="submit"
              className="px-3 py-2 rounded-lg text-sm font-medium"
              style={{ backgroundColor: 'var(--accent)', color: '#0f1117' }}
            >
              run
            </button>
          </form>
        </div>
      </div>

      <div
        className={`pointer-events-none absolute inset-0 rounded-2xl flex items-center justify-center transition-all duration-500 ${phase === 'routing' ? 'opacity-100' : 'opacity-0'}`}
        style={{ background: target === 'invest' ? 'rgba(248,250,252,0.75)' : 'rgba(15,17,23,0.75)' }}
      >
        <div className="text-center">
          <div className="text-sm font-mono mb-3" style={{ color: target === 'invest' ? '#0f172a' : '#e2e8f0' }}>
            switching theme → {target ? `console.log(${target})` : ''}
          </div>
          <div className="w-56 h-1.5 rounded-full overflow-hidden" style={{ background: target === 'invest' ? '#cbd5e1' : '#334155' }}>
            <div className={`h-full ${phase === 'routing' ? 'w-full' : 'w-0'} transition-all duration-500`} style={{ background: target === 'invest' ? '#2563eb' : '#63b3ed' }} />
          </div>
        </div>
      </div>
    </div>
  );
}
