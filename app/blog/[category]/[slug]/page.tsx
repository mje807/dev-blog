import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getPostContent, getAllSlugs, CATEGORIES } from '@/lib/posts';

interface Props {
  params: Promise<{ category: string; slug: string }>;
}

export async function generateStaticParams() {
  return getAllSlugs();
}

export async function generateMetadata({ params }: Props) {
  const { category, slug } = await params;
  const post = await getPostContent(category, slug);
  if (!post) return {};
  return {
    title: `${post.title} | 종구리.dev`,
    description: post.excerpt,
  };
}

export default async function PostPage({ params }: Props) {
  const { category, slug } = await params;
  const post = await getPostContent(category, slug);
  if (!post) notFound();

  const categoryMeta = CATEGORIES[post.category];

  return (
    <article className="max-w-3xl mx-auto">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-2 text-sm mb-8" style={{ color: 'var(--text-muted)' }}>
        <Link href="/" className="hover:underline">Home</Link>
        <span>/</span>
        <Link href="/blog" className="hover:underline">Blog</Link>
        <span>/</span>
        <Link href={`/blog/${post.category}`} className="hover:underline">
          {categoryMeta?.label || post.category}
        </Link>
      </nav>

      {/* Header */}
      <header className="mb-10">
        <div className="flex items-center gap-2 mb-4">
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${categoryMeta?.color || 'bg-gray-100 text-gray-800'}`}>
            {categoryMeta?.label || post.category}
          </span>
          <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
            {new Date(post.date).toLocaleDateString('ko-KR', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })}
          </span>
        </div>

        <h1 className="text-3xl font-extrabold leading-tight mb-4" style={{ color: 'var(--text)' }}>
          {post.title}
        </h1>

        {post.tags.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {post.tags.map(tag => (
              <span
                key={tag}
                className="text-xs px-2 py-0.5 rounded"
                style={{ backgroundColor: '#1a202c', color: 'var(--text-muted)' }}
              >
                #{tag}
              </span>
            ))}
          </div>
        )}
      </header>

      {/* Divider */}
      <hr className="mb-10" style={{ borderColor: 'var(--border)' }} />

      {/* Content */}
      <div
        className="prose"
        dangerouslySetInnerHTML={{ __html: post.content || '' }}
      />

      {/* Footer nav */}
      <div className="mt-16 pt-8 border-t" style={{ borderColor: 'var(--border)' }}>
        <Link
          href={`/blog/${post.category}`}
          className="inline-flex items-center gap-2 text-sm"
          style={{ color: 'var(--accent)' }}
        >
          ← {categoryMeta?.label} 글 더 보기
        </Link>
      </div>
    </article>
  );
}
