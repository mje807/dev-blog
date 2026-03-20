import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getPostsByCategory, CATEGORIES } from '@/lib/posts';
import BlogPostBrowser from '@/components/BlogPostBrowser';
import PageHeader from '@/components/ui/PageHeader';
import EmptyState from '@/components/ui/EmptyState';

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
    title: `${meta.label} Archive`,
    description: `${meta.label} 관련 개발 글을 모아보는 Dev Archive 카테고리 페이지.`,
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
        title={`${meta.label} Archive`}
        subtitle={<><Link href="/blog" className="text-sm mr-2" style={{ color: 'var(--text-muted)' }}>← Dev Archive</Link><span>{posts.length}개의 글</span></>}
        right={<span className={`text-sm px-2 py-0.5 rounded-full ${meta.color}`}>{posts.length}</span>}
      />

      {posts.length === 0 ? (
        <EmptyState
          eyebrow="Category zero-state"
          icon="📂"
          title={`${meta.label} 카테고리는 아직 비어 있습니다`}
          description="이 카테고리는 Dev Archive 안에서 별도 축으로 운영될 예정입니다. 지금은 구조를 먼저 정리하는 단계라, 첫 공개 글이 올라오면 여기서 바로 탐색할 수 있게 준비해두었습니다."
          actions={[
            { href: '/blog', label: 'Dev Archive로 돌아가기', primary: true },
            { href: '/dev', label: 'console.log(dev) 보기' },
          ]}
        />
      ) : (
        <div className="rounded-xl border p-4" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-card)' }}>
          <BlogPostBrowser posts={posts} />
        </div>
      )}
    </div>
  );
}
