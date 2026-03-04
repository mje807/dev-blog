'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import useMotionPreset from '@/app/design/useMotionPreset';

const navLinks = [
  { href: '/', label: 'Console' },
  { href: '/dev', label: 'Dev' },
  { href: '/invest', label: 'Invest' },
  { href: '/blog', label: 'All Posts' },
];

function getBrand(pathname: string) {
  if (pathname.startsWith('/invest')) return 'console.log(invest)';
  if (pathname.startsWith('/dev') || pathname.startsWith('/blog')) return 'console.log(dev)';
  return 'console.log()';
}

export default function SiteHeader() {
  const pathname = usePathname();
  const brand = getBrand(pathname);
  const { style: motionStyle } = useMotionPreset('quick', 'color, background-color, border-color, opacity');

  return (
    <header className="sticky top-0 z-50 border-b backdrop-blur-md" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--header-bg)' }}>
      <div className="max-w-4xl mx-auto px-6 h-14 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2 font-bold text-lg" style={{ ...motionStyle, color: 'var(--accent)' }}>
          <span>⌨️</span>
          <span>{brand}</span>
        </Link>
        <nav className="flex items-center gap-6">
          {navLinks.map((link) => (
            <Link key={link.href} href={link.href} className="text-sm transition-colors" style={{ ...motionStyle, color: 'var(--text-muted)' }}>
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
