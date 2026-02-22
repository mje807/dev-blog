import Link from 'next/link';
import { Post, CATEGORIES } from '@/lib/posts';

interface PostCardProps {
  post: Post;
  featured?: boolean;
}

export default function PostCard({ post, featured = false }: PostCardProps) {
  const category = CATEGORIES[post.category];
  const href = `/blog/${post.category}/${post.slug}`;

  return (
    <Link href={href} className="block group">
      <article className="post-card rounded-xl border p-5 transition-all duration-200 h-full">
        {/* Category badge */}
        <div className="flex items-center gap-2 mb-3">
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${category?.color || 'bg-gray-100 text-gray-800'}`}>
            {category?.label || post.category}
          </span>
          <span className="text-xs post-muted">
            {new Date(post.date).toLocaleDateString('ko-KR', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })}
          </span>
        </div>

        {/* Title */}
        <h2 className={`font-bold leading-snug mb-2 post-title group-hover:underline underline-offset-4 ${featured ? 'text-xl' : 'text-base'}`}>
          {post.title}
        </h2>

        {/* Excerpt */}
        <p className="text-sm line-clamp-2 post-muted">
          {post.excerpt}
        </p>

        {/* Tags */}
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
