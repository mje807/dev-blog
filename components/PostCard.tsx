import Link from 'next/link';
import type { Post } from '@/lib/posts';
import { CATEGORIES } from '@/lib/content/categories';

interface PostCardProps {
  post: Post;
  featured?: boolean;
}

function estimateReadMinutes(text: string): number {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').length;
  return Math.max(3, Math.round(words / 220));
}

function detectDifficulty(post: Post): '입문' | '중급' | '심화' {
  const title = `${post.title} ${post.excerpt}`.toLowerCase();
  if (/(runtime|hydration|federation|distributed|cache|rsc|lane|fiber|ssr)/i.test(title)) return '심화';
  if (/(architecture|pattern|state|mfe|router|infra)/i.test(title)) return '중급';
  return '입문';
}

function keyQuestion(post: Post): string {
  const q = post.title.replace(/["'“”]/g, '').trim();
  return q.endsWith('?') ? q : `${q}를 실제 운영에서 어떻게 풀어야 할까?`;
}

export default function PostCard({ post, featured = false }: PostCardProps) {
  const category = CATEGORIES[post.category];
  const href = `/blog/${post.category}/${post.slug}`;
  const readMins = estimateReadMinutes(`${post.title} ${post.excerpt}`);
  const difficulty = detectDifficulty(post);

  return (
    <Link href={href} className="block group">
      <article className="post-card rounded-xl border p-5 transition-all duration-200 h-full">
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${category?.color || 'bg-gray-100 text-gray-800'}`}>
            {category?.label || post.category}
          </span>
          {post.featured && (
            <span
              className="text-xs font-medium px-2 py-0.5 rounded-full border"
              style={{ borderColor: 'var(--accent)', color: 'var(--accent)', backgroundColor: 'rgba(99,179,237,0.1)' }}
            >
              Featured
            </span>
          )}
          {post.series && (
            <span
              className="text-xs font-medium px-2 py-0.5 rounded-full border"
              style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
            >
              Series
            </span>
          )}
          <span className="text-xs post-muted">
            {new Date(post.date).toLocaleDateString('ko-KR', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })}
          </span>
        </div>

        <h2 className={`font-bold leading-snug mb-2 post-title group-hover:underline underline-offset-4 ${featured ? 'text-xl' : 'text-base'}`}>
          {post.title}
        </h2>

        <p className="text-sm mb-2 key-question">
          ❓ {keyQuestion(post)}
        </p>

        <p className="text-sm line-clamp-2 post-muted">
          {post.excerpt}
        </p>

        <div className="flex items-center gap-2 mt-3">
          <span className={`difficulty-badge ${difficulty === '심화' ? 'hard' : difficulty === '중급' ? 'mid' : 'easy'}`}>
            {difficulty}
          </span>
          <span className="read-time">⏱️ {readMins}분</span>
        </div>

        {post.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-3">
            {post.tags.slice(0, 4).map(tag => (
              <span key={tag} className="text-xs px-1.5 py-0.5 rounded post-tag">
                #{tag}
              </span>
            ))}
          </div>
        )}
      </article>
    </Link>
  );
}
