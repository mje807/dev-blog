import type { ReactNode } from 'react';

export default function SectionCard({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-xl border p-4 ${className}`} style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-card)' }}>
      {children}
    </section>
  );
}
