import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getPostsByCategory, CATEGORIES } from '@/lib/posts';
import BlogPostBrowser from '@/components/BlogPostBrowser';
import PageHeader from '@/components/ui/PageHeader';

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
      <PageHeader
        title={meta.label}
        subtitle={<><Link href="/blog" className="text-sm mr-2" style={{ color: 'var(--text-muted)' }}>← All Posts</Link><span>{posts.length}개 글</span></>}
        right={<span className={`text-sm px-2 py-0.5 rounded-full ${meta.color}`}>{posts.length}</span>}
      />

      {posts.length === 0 ? (
        <p style={{ color: 'var(--text-muted)' }}>아직 작성된 글이 없습니다.</p>
      ) : (
        <div className="rounded-xl border p-4" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-card)' }}>
          <BlogPostBrowser posts={posts} />
        </div>
      )}
    </div>
  );
}
