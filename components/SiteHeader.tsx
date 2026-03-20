'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import useMotionPreset from '@/app/design/useMotionPreset';

const navLinks = [
  { href: '/', label: 'Console', match: (pathname: string) => pathname === '/' },
  { href: '/dev', label: 'Dev', match: (pathname: string) => pathname.startsWith('/dev') },
  { href: '/invest', label: 'Invest', match: (pathname: string) => pathname.startsWith('/invest') },
  { href: '/blog', label: 'Dev Archive', match: (pathname: string) => pathname.startsWith('/blog') },
];

function getBrand(pathname: string) {
  if (pathname.startsWith('/invest')) return 'console.log(invest)';
  if (pathname.startsWith('/dev') || pathname.startsWith('/blog')) return 'console.log(dev)';
  return '종구리.dev';
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
          <div className="leading-tight">
            <div>{brand}</div>
            <div className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>by 종구리.dev</div>
          </div>
        </Link>
        <nav className="flex items-center gap-3 sm:gap-6">
          {navLinks.map((link) => {
            const active = link.match(pathname);
            return (
              <Link
                key={link.href}
                href={link.href}
                className="text-sm transition-colors px-2 py-1 rounded-md border"
                style={active
                  ? { ...motionStyle, color: 'var(--text)', borderColor: 'var(--accent)', backgroundColor: 'rgba(99,179,237,0.12)' }
                  : { ...motionStyle, color: 'var(--text-muted)', borderColor: 'transparent' }}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
