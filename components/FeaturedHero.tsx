import Link from 'next/link';
import type { Post } from '@/lib/posts';
import { CATEGORIES } from '@/lib/content/categories';

function estimateReadMinutes(text: string): number {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').length;
  return Math.max(3, Math.round(words / 220));
}

export default function FeaturedHero({ post }: { post: Post }) {
  const category = CATEGORIES[post.category];
  const readMins = estimateReadMinutes(`${post.title} ${post.excerpt}`);

  return (
    <Link href={`/blog/${post.category}/${post.slug}`} className="block rounded-2xl border p-6 md:p-8 featured-hero">
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <span className="text-xs font-semibold uppercase tracking-[0.18em] px-2.5 py-1 rounded-full featured-hero-badge">
          Featured
        </span>
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${category?.color || 'bg-gray-100 text-gray-800'}`}>
          {category?.label || post.category}
        </span>
        {post.series && (
          <span className="text-xs font-medium px-2 py-0.5 rounded-full border" style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}>
            {post.series}
          </span>
        )}
      </div>

      <h2 className="text-2xl md:text-3xl font-extrabold leading-tight mb-4" style={{ color: 'var(--text)' }}>
        {post.title}
      </h2>

      <p className="text-base md:text-lg leading-7 max-w-2xl mb-5" style={{ color: 'var(--text-muted)' }}>
        {post.excerpt}
      </p>

      <div className="flex flex-wrap items-center gap-3 text-sm" style={{ color: 'var(--text-muted)' }}>
        <span>{new Date(post.date).toLocaleDateString('ko-KR')}</span>
        <span>·</span>
        <span>⏱️ {readMins}분</span>
        <span>·</span>
        <span>대표 글로 큐레이션됨</span>
      </div>

      {post.tags.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-5">
          {post.tags.slice(0, 4).map((tag) => (
            <span key={tag} className="text-xs px-2 py-0.5 rounded featured-hero-tag">
              #{tag}
            </span>
          ))}
        </div>
      )}
    </Link>
  );
}
