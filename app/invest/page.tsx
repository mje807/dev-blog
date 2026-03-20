import Link from 'next/link';

export const metadata = {
  title: 'console.log(invest)',
  description: '배당주, 거시지표, 포트폴리오 기록을 준비 중인 teaser surface.',
};

export default function InvestPage() {
  return (
    <div className="space-y-10">
      <section className="py-10 text-center">
        <div className="text-5xl mb-5">📈</div>
        <h1 className="text-4xl font-extrabold mb-4" style={{ color: 'var(--text)' }}>
          console.log(invest)
        </h1>
        <p className="text-lg max-w-2xl mx-auto" style={{ color: 'var(--text-muted)' }}>
          배당주/거시지표/포트폴리오 중심 투자 인사이트를 준비 중인 teaser surface
        </p>
      </section>

      <section className="rounded-xl border p-6" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-card)' }}>
        <h2 className="text-lg font-bold mb-3" style={{ color: 'var(--text)' }}>준비중인 구조</h2>
        <ul className="space-y-2 text-sm" style={{ color: 'var(--text-muted)' }}>
          <li>• 주간 마켓 브리프 (거시 + 배당환경 점수)</li>
          <li>• 배당 왕족/귀족/배당성장 심층노트</li>
          <li>• 포트폴리오 액션로그 (가설/리스크/체크포인트)</li>
        </ul>
        <div className="flex gap-3 mt-5">
          <Link href="/dev" className="px-4 py-2 rounded-lg text-sm border" style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}>
            console.log(dev)
          </Link>
          <Link href="/blog" className="px-4 py-2 rounded-lg text-sm" style={{ backgroundColor: 'var(--accent)', color: '#0f1117' }}>
            Dev Archive 보기
          </Link>
        </div>
      </section>
    </div>
  );
}
