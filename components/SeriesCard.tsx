import Link from 'next/link';
import type { SeriesGroup } from '@/lib/posts';
import { CATEGORIES } from '@/lib/content/categories';

function toSeriesSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export default function SeriesCard({ series }: { series: SeriesGroup }) {
  const preview = series.posts.slice(0, 3);
  const slug = toSeriesSlug(series.name);

  return (
    <Link
      href={`/blog/series/${slug}`}
      className="block rounded-xl border p-5 hover:opacity-90"
      style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-card)' }}
    >
      <div className="text-xs font-semibold uppercase tracking-[0.16em] mb-2" style={{ color: 'var(--accent)' }}>
        Series
      </div>
      <h3 className="font-bold mb-2" style={{ color: 'var(--text)' }}>{series.name}</h3>
      <p className="text-sm mb-3" style={{ color: 'var(--text-muted)' }}>
        {series.posts.length}개의 글 · {series.categories.length}개 카테고리
      </p>
      <div className="space-y-2 mb-3">
        {preview.map((post, index) => (
          <div key={`${post.category}-${post.slug}`} className="text-sm" style={{ color: 'var(--text-muted)' }}>
            {index + 1}. {post.title}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
        {series.categories.map((categoryKey) => (
          <span key={categoryKey} className={`px-2 py-0.5 rounded-full ${CATEGORIES[categoryKey]?.color || 'bg-gray-100 text-gray-800'}`}>
            {CATEGORIES[categoryKey]?.label || categoryKey}
          </span>
        ))}
      </div>
    </Link>
  );
}
