import Link from 'next/link';
import { getAllPosts, CATEGORIES } from '@/lib/posts';
import PostCard from '@/components/PostCard';

export default function HomePage() {
  const allPosts = getAllPosts();
  const recent = allPosts.slice(0, 6);

  const categoryStats = Object.entries(CATEGORIES).map(([key, meta]) => ({
    key,
    ...meta,
    count: allPosts.filter(p => p.category === key).length,
  })).filter(c => c.count > 0);

  return (
    <div className="space-y-16">
      {/* Hero */}
      <section className="py-10 text-center">
        <div className="text-5xl mb-5">⌨️</div>
        <h1 className="text-4xl font-extrabold mb-4" style={{ color: 'var(--text)' }}>
          종구리.dev
        </h1>
        <p className="text-lg max-w-xl mx-auto" style={{ color: 'var(--text-muted)' }}>
          8년차 시니어 프론트엔드 개발자.<br />
          React 심층 분석 · Micro Frontends · AI 활용 개발 이야기.
        </p>
        <div className="flex items-center justify-center gap-4 mt-6">
          <Link
            href="/blog"
            className="px-5 py-2.5 rounded-lg text-sm font-medium transition-colors"
            style={{ backgroundColor: 'var(--accent)', color: '#0f1117' }}
          >
            전체 포스트 →
          </Link>
          <a
            href="https://github.com/mje807"
            target="_blank"
            rel="noopener noreferrer"
            className="px-5 py-2.5 rounded-lg text-sm font-medium border transition-colors"
            style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
          >
            GitHub ↗
          </a>
        </div>
      </section>

      {/* Categories */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider mb-4" style={{ color: 'var(--text-muted)' }}>
          카테고리
        </h2>
        <div className="flex flex-wrap gap-3">
          {categoryStats.map(cat => (
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
      </section>

      {/* Recent posts */}
      <section>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-xl font-bold" style={{ color: 'var(--text)' }}>최근 포스트</h2>
          <Link href="/blog" className="text-sm" style={{ color: 'var(--accent)' }}>
            전체 보기 →
          </Link>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {recent.map((post, i) => (
            <PostCard key={post.slug} post={post} featured={i === 0} />
          ))}
        </div>
      </section>
    </div>
  );
}
