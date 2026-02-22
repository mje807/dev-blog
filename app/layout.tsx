import type { Metadata } from 'next';
import './globals.css';
import Link from 'next/link';

export const metadata: Metadata = {
  title: '종구리 Dev Blog',
  description: '프론트엔드 아키텍처, React 심층 분석, AI 활용 개발 이야기',
  openGraph: {
    title: '종구리 Dev Blog',
    description: '프론트엔드 아키텍처, React 심층 분석, AI 활용 개발 이야기',
    locale: 'ko_KR',
    type: 'website',
  },
};

const navLinks = [
  { href: '/', label: 'Home' },
  { href: '/blog', label: 'All Posts' },
  { href: '/blog/react', label: 'React' },
  { href: '/blog/frontend-architecture', label: 'Architecture' },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body className="min-h-screen flex flex-col">
        {/* Header */}
        <header className="sticky top-0 z-50 border-b backdrop-blur-md" style={{ borderColor: 'var(--border)', backgroundColor: 'rgba(15,17,23,0.85)' }}>
          <div className="max-w-4xl mx-auto px-6 h-14 flex items-center justify-between">
            <Link href="/" className="flex items-center gap-2 font-bold text-lg" style={{ color: 'var(--accent)' }}>
              <span>⌨️</span>
              <span>종구리.dev</span>
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
          <p>© 2025 종구리.dev · 8년차 시니어 프론트엔드 개발자의 기술 블로그</p>
        </footer>
      </body>
    </html>
  );
}
