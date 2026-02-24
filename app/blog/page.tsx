import Link from 'next/link';
import { getAllPosts, CATEGORIES } from '@/lib/posts';
import BlogPostBrowser from '@/components/BlogPostBrowser';

export const metadata = {
  title: '전체 포스트 | 종구리.dev',
};

export default function BlogPage() {
  const posts = getAllPosts();

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2" style={{ color: 'var(--text)' }}>All Posts</h1>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{posts.length}개의 글</p>
      </div>

      {/* Category filter */}
      <div className="flex flex-wrap gap-2 mb-8">
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

      <BlogPostBrowser posts={posts} />
    </div>
  );
}
