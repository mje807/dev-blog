import Link from 'next/link';
import type { Post } from '@/lib/posts';
import { CATEGORIES } from '@/lib/content/categories';

export default function PostLinkCard({
  post,
  label,
}: {
  post: Post;
  label: string;
}) {
  const category = CATEGORIES[post.category];

  return (
    <Link
      href={`/blog/${post.category}/${post.slug}`}
      className="block rounded-xl border p-4 hover:opacity-90"
      style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-card)' }}
    >
      <div className="text-xs font-semibold uppercase tracking-[0.16em] mb-2" style={{ color: 'var(--accent)' }}>
        {label}
      </div>
      <div className="font-semibold mb-2" style={{ color: 'var(--text)' }}>{post.title}</div>
      <div className="text-sm line-clamp-2 mb-3" style={{ color: 'var(--text-muted)' }}>{post.excerpt}</div>
      <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
        <span>{category?.label || post.category}</span>
        <span>·</span>
        <span>{new Date(post.date).toLocaleDateString('ko-KR')}</span>
      </div>
    </Link>
  );
}
