import Link from 'next/link';
import { getAllPosts, CATEGORIES } from '@/lib/posts';
import BlogPostBrowser from '@/components/BlogPostBrowser';
import PageHeader from '@/components/ui/PageHeader';
import SectionCard from '@/components/ui/SectionCard';
import EmptyState from '@/components/ui/EmptyState';

export const metadata = {
  title: 'Dev Archive',
  description: 'console.log(dev)에 쌓이는 개발 글을 카테고리별로 탐색하는 아카이브.',
};

export default function BlogPage() {
  const posts = getAllPosts();

  return (
    <div>
      <PageHeader
        title="Dev Archive"
        subtitle={posts.length > 0
          ? `${posts.length}개의 개발 글이 정리된 아카이브`
          : 'console.log(dev)에 쌓일 개발 기록을 위한 아카이브 공간입니다.'}
      />

      {/* Category filter */}
      <SectionCard className="mb-8">
      <div className="flex flex-wrap gap-2">
        <Link
          href="/blog"
          className="px-3 py-1.5 rounded-lg text-sm border font-medium"
          style={{ borderColor: 'var(--accent)', color: 'var(--accent)', backgroundColor: 'rgba(99,179,237,0.1)' }}
        >
          전체
        </Link>
        {Object.entries(CATEGORIES).map(([key, meta]) => {
          const count = posts.filter(p => p.category === key).length;
          if (!count) return null;
          return (
            <Link
              key={key}
              href={`/blog/${key}`}
              className="px-3 py-1.5 rounded-lg text-sm border transition-colors"
              style={{ borderColor: 'var(--border)', color: 'var(--text-muted)', backgroundColor: 'var(--bg-card)' }}
            >
              {meta.label} ({count})
            </Link>
          );
        })}
      </div>
      </SectionCard>

      <SectionCard>
        {posts.length === 0 ? (
          <EmptyState
            eyebrow="Archive zero-state"
            icon="🗃️"
            title="아직 공개된 개발 글은 없습니다"
            description="지금은 구조를 먼저 정리하는 단계입니다. 이 공간에는 React, 프론트엔드 아키텍처, AI 활용 개발 기록이 순차적으로 쌓일 예정입니다."
            bullets={[
              '카테고리별로 개발 아티클을 정리합니다.',
              '초기에는 dev 중심 글부터 아카이브됩니다.',
              'invest는 별도 teaser surface로 유지됩니다.',
            ]}
            actions={[
              { href: '/dev', label: 'console.log(dev)로 돌아가기', primary: true },
              { href: '/invest', label: 'console.log(invest) 보기' },
            ]}
          />
        ) : (
          <BlogPostBrowser posts={posts} />
        )}
      </SectionCard>
    </div>
  );
}
