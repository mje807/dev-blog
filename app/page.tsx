'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Mode = 'idle' | 'routing';

export default function ConsoleLauncherPage() {
  const router = useRouter();
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<Mode>('idle');
  const [logs, setLogs] = useState<string[]>([
    'console.log launcher initialized.',
    'type: dev | invest | help',
  ]);

  const runCommand = (raw: string) => {
    const cmd = raw.trim().toLowerCase();
    const normalized = cmd
      .replace('console.log(', '')
      .replace(')', '')
      .replace(/['"`]/g, '')
      .trim();

    setLogs((prev) => [...prev, `> ${raw}`]);

    if (!normalized) return;
    if (normalized === 'help') {
      setLogs((prev) => [...prev, 'available: dev | invest']);
      return;
    }

    if (normalized === 'dev' || normalized === 'invest') {
      setLogs((prev) => [...prev, `routing to console.log(${normalized}) ...`]);
      setMode('routing');
      setTimeout(() => router.push(`/${normalized}`), 420);
      return;
    }

    setLogs((prev) => [...prev, `unknown command: ${raw}`]);
  };

  return (
    <div
      className={`transition-all duration-500 ${mode === 'routing' ? 'opacity-0 -translate-y-2 scale-[0.99]' : 'opacity-100 translate-y-0 scale-100'}`}
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
            if (!input.trim()) return;
            const raw = input;
            setInput('');
            runCommand(raw);
          }}
        >
          <span className="text-sm font-mono" style={{ color: 'var(--accent)' }}>{'>'}</span>
          <input
            autoFocus
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
  );
}
