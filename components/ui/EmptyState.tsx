import Link from 'next/link';
import type { ReactNode } from 'react';

interface EmptyStateAction {
  href: string;
  label: string;
  primary?: boolean;
}

export default function EmptyState({
  eyebrow,
  title,
  description,
  bullets = [],
  actions = [],
  icon = '🗂️',
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description: ReactNode;
  bullets?: ReactNode[];
  actions?: EmptyStateAction[];
  icon?: ReactNode;
}) {
  return (
    <section className="rounded-2xl border p-6 sm:p-7" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-card)' }}>
      <div className="text-3xl mb-4">{icon}</div>
      {eyebrow ? (
        <p className="text-xs font-semibold uppercase tracking-[0.18em] mb-3" style={{ color: 'var(--accent)' }}>
          {eyebrow}
        </p>
      ) : null}
      <h2 className="text-2xl font-bold mb-3" style={{ color: 'var(--text)' }}>
        {title}
      </h2>
      <p className="text-sm leading-6 max-w-2xl" style={{ color: 'var(--text-muted)' }}>
        {description}
      </p>

      {bullets.length > 0 ? (
        <ul className="mt-5 space-y-2 text-sm" style={{ color: 'var(--text-muted)' }}>
          {bullets.map((bullet, index) => (
            <li key={index} className="flex gap-2">
              <span style={{ color: 'var(--accent)' }}>•</span>
              <span>{bullet}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {actions.length > 0 ? (
        <div className="flex flex-wrap gap-3 mt-6">
          {actions.map((action) => (
            <Link
              key={`${action.href}-${action.label}`}
              href={action.href}
              className="px-4 py-2 rounded-lg text-sm font-medium border"
              style={action.primary
                ? { backgroundColor: 'var(--accent)', color: '#0f1117', borderColor: 'var(--accent)' }
                : { borderColor: 'var(--border)', color: 'var(--text-muted)' }}
            >
              {action.label}
            </Link>
          ))}
        </div>
      ) : null}
    </section>
  );
}
