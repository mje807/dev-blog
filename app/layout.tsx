import type { Metadata } from 'next';
import './globals.css';
import ThemeController from '@/components/ThemeController';
import SiteHeader from '@/components/SiteHeader';

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
          <p>© 2025 console.log(dev) · console.log(invest)</p>
        </footer>
      </body>
    </html>
  );
}
