import Link from 'next/link';
import { getAllPosts, CATEGORIES } from '@/lib/posts';
import BlogPostBrowser from '@/components/BlogPostBrowser';
import PageHeader from '@/components/ui/PageHeader';
import SectionCard from '@/components/ui/SectionCard';

export const metadata = {
  title: '전체 포스트 | 종구리.dev',
};

export default function BlogPage() {
  const posts = getAllPosts();

  return (
    <div>
      <PageHeader title="All Posts" subtitle={`${posts.length}개의 글`} />

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
        <BlogPostBrowser posts={posts} />
      </SectionCard>
    </div>
  );
}
