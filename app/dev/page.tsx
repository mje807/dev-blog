import Link from 'next/link';
import { getAllPosts, CATEGORIES } from '@/lib/posts';
import PostCard from '@/components/PostCard';
import PageHeader from '@/components/ui/PageHeader';
import SectionCard from '@/components/ui/SectionCard';
import EmptyState from '@/components/ui/EmptyState';

export const metadata = {
  title: 'console.log(dev)',
  description: 'React 심층 분석, 프론트엔드 아키텍처, AI 활용 개발 인사이트를 다루는 메인 dev 랜딩.',
};

export default function DevPage() {
  const allPosts = getAllPosts();
  const recent = allPosts.slice(0, 6);

  const categoryStats = Object.entries(CATEGORIES)
    .map(([key, meta]) => ({
      key,
      ...meta,
      count: allPosts.filter((p) => p.category === key).length,
    }))
    .filter((c) => c.count > 0);

  return (
    <div className="space-y-10">
      <PageHeader
        title={<span><span className="mr-2">⌨️</span>console.log(dev)</span>}
        subtitle="React 심층 분석 · Frontend Architecture · AI 활용 개발 인사이트"
      />

      <section>
        <div className="flex items-center justify-center gap-4">
          <Link
            href="/blog"
            className="px-5 py-2.5 rounded-lg text-sm font-medium transition-colors"
            style={{ backgroundColor: 'var(--accent)', color: '#0f1117' }}
          >
            개발 포스트 보기 →
          </Link>
          <Link
            href="/invest"
            className="px-5 py-2.5 rounded-lg text-sm font-medium border transition-colors"
            style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
          >
            console.log(invest) ↗
          </Link>
        </div>
      </section>

      <section>
        <SectionCard>
          <h2 className="text-sm font-semibold uppercase tracking-wider mb-4" style={{ color: 'var(--text-muted)' }}>
            카테고리
          </h2>
          {categoryStats.length > 0 ? (
            <div className="flex flex-wrap gap-3">
              {categoryStats.map((cat) => (
                <Link
                  key={cat.key}
                  href={`/blog/${cat.key}`}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg border text-sm transition-all"
                  style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-card)', color: 'var(--text)' }}
                >
                  <span className={`text-xs px-1.5 py-0.5 rounded-full ${cat.color}`}>{cat.count}</span>
                  {cat.label}
                </Link>
              ))}
            </div>
          ) : (
            <div className="text-sm leading-6" style={{ color: 'var(--text-muted)' }}>
              아카이브 구조를 먼저 정리하는 중입니다. 첫 공개 글이 올라오면 카테고리 탐색이 여기서 시작됩니다.
            </div>
          )}
        </SectionCard>
      </section>

      <section>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-xl font-bold" style={{ color: 'var(--text)' }}>
            최근 개발 포스트
          </h2>
          <Link href="/blog" className="text-sm" style={{ color: 'var(--accent)' }}>
            Dev Archive 보기 →
          </Link>
        </div>
        {recent.length > 0 ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {recent.map((post, i) => (
              <PostCard key={post.slug} post={post} featured={i === 0} />
            ))}
          </div>
        ) : (
          <EmptyState
            eyebrow="Dev landing"
            icon="⌨️"
            title="첫 개발 기록을 위한 구조를 준비 중입니다"
            description="지금은 글을 많이 쌓기보다, dev 중심 정보구조와 아카이브 UX를 먼저 안정화하는 단계입니다. 공개가 시작되면 최신 글이 이 영역에 우선 노출됩니다."
            bullets={[
              'React 심층 분석',
              '프론트엔드 아키텍처와 운영 경험',
              'AI를 활용한 개발 워크플로 기록',
            ]}
            actions={[
              { href: '/blog', label: 'Dev Archive 보기', primary: true },
              { href: '/invest', label: 'console.log(invest) teaser 보기' },
            ]}
          />
        )}
      </section>
    </div>
  );
}
