import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getPostsByCategory, CATEGORIES } from '@/lib/posts';
import BlogPostBrowser from '@/components/BlogPostBrowser';

interface Props {
  params: Promise<{ category: string }>;
}

export async function generateStaticParams() {
  return Object.keys(CATEGORIES).map(category => ({ category }));
}

export async function generateMetadata({ params }: Props) {
  const { category } = await params;
  const meta = CATEGORIES[category];
  if (!meta) return {};
  return {
    title: `${meta.label} | 종구리.dev`,
  };
}

export default async function CategoryPage({ params }: Props) {
  const { category } = await params;
  const meta = CATEGORIES[category];
  if (!meta) notFound();

  const posts = getPostsByCategory(category);

  return (
    <div>
      <div className="mb-8">
        <Link href="/blog" className="text-sm mb-3 inline-block" style={{ color: 'var(--text-muted)' }}>
          ← All Posts
        </Link>
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-bold" style={{ color: 'var(--text)' }}>{meta.label}</h1>
          <span className={`text-sm px-2 py-0.5 rounded-full ${meta.color}`}>{posts.length}</span>
        </div>
      </div>

      {posts.length === 0 ? (
        <p style={{ color: 'var(--text-muted)' }}>아직 작성된 글이 없습니다.</p>
      ) : (
        <BlogPostBrowser posts={posts} />
      )}
    </div>
  );
}
