import type { Metadata } from 'next';
import './globals.css';
import ThemeController from '@/components/ThemeController';
import SiteHeader from '@/components/SiteHeader';

export const metadata: Metadata = {
  title: {
    default: 'console.log(dev) | 종구리.dev',
    template: '%s | 종구리.dev',
  },
  description: 'React, 프론트엔드 아키텍처, AI 활용 개발 인사이트를 쌓아가는 dev 중심 아카이브.',
  openGraph: {
    title: 'console.log(dev) | 종구리.dev',
    description: 'React, 프론트엔드 아키텍처, AI 활용 개발 인사이트를 쌓아가는 dev 중심 아카이브.',
    locale: 'ko_KR',
    type: 'website',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body className="min-h-screen flex flex-col">
        <ThemeController />
        <SiteHeader />
        {/* Main */}
        <main className="flex-1 max-w-4xl mx-auto w-full px-6 py-10">
          {children}
        </main>

        {/* Footer */}
        <footer className="border-t py-8 text-center text-sm" style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}>
          <p>© 2025 종구리.dev · console.log(dev) archive</p>
        </footer>
      </body>
    </html>
  );
}
