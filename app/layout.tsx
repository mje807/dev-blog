import type { Metadata } from 'next';
import './globals.css';
import Link from 'next/link';
import ThemeController from '@/components/ThemeController';

export const metadata: Metadata = {
  title: 'console.log(dev) / console.log(invest)',
  description: '개발과 투자 인사이트를 콘솔 UI로 탐색하는 지식 허브',
  openGraph: {
    title: 'console.log(dev) / console.log(invest)',
    description: '개발과 투자 인사이트를 콘솔 UI로 탐색하는 지식 허브',
    locale: 'ko_KR',
    type: 'website',
  },
};

const navLinks = [
  { href: '/', label: 'Console' },
  { href: '/dev', label: 'Dev' },
  { href: '/invest', label: 'Invest' },
  { href: '/blog', label: 'All Posts' },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body className="min-h-screen flex flex-col">
        <ThemeController />
        {/* Header */}
        <header className="sticky top-0 z-50 border-b backdrop-blur-md" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--header-bg)' }}>
          <div className="max-w-4xl mx-auto px-6 h-14 flex items-center justify-between">
            <Link href="/" className="flex items-center gap-2 font-bold text-lg" style={{ color: 'var(--accent)' }}>
              <span>⌨️</span>
              <span>console.log(dev) · console.log(invest)</span>
            </Link>
            <nav className="flex items-center gap-6">
              {navLinks.map(link => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="text-sm transition-colors"
                  style={{ color: 'var(--text-muted)' }}
                >
                  {link.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>

        {/* Main */}
        <main className="flex-1 max-w-4xl mx-auto w-full px-6 py-10">
          {children}
        </main>

        {/* Footer */}
        <footer className="border-t py-8 text-center text-sm" style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}>
          <p>© 2025 console.log(dev) · console.log(invest)</p>
        </footer>
      </body>
    </html>
  );
}
