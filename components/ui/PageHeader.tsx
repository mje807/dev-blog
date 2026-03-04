import type { ReactNode } from 'react';

export default function PageHeader({
  title,
  subtitle,
  right,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="mb-8 rounded-2xl border p-5" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-card)' }}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold mb-2" style={{ color: 'var(--text)' }}>{title}</h1>
          {subtitle ? <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{subtitle}</p> : null}
        </div>
        {right ? <div>{right}</div> : null}
      </div>
    </div>
  );
}
