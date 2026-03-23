import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getSeriesGroupBySlug, getSeriesSlugs } from '@/lib/posts';
import PageHeader from '@/components/ui/PageHeader';
import SectionCard from '@/components/ui/SectionCard';
import PostLinkCard from '@/components/PostLinkCard';

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams() {
  return getSeriesSlugs();
}

export async function generateMetadata({ params }: Props) {
  const { slug } = await params;
  const series = getSeriesGroupBySlug(slug);
  if (!series) return {};

  return {
    title: `${series.name} Series`,
    description: `${series.name} 시리즈에 포함된 글 ${series.posts.length}개를 모아보는 페이지.`,
  };
}

export default async function SeriesPage({ params }: Props) {
  const { slug } = await params;
  const series = getSeriesGroupBySlug(slug);
  if (!series) notFound();

  return (
    <div className="space-y-8">
      <PageHeader
        title={`${series.name} Series`}
        subtitle={`${series.posts.length}개의 글 · ${series.categories.length}개 카테고리`}
      />

      <SectionCard>
        <div className="flex items-center gap-2 text-sm flex-wrap" style={{ color: 'var(--text-muted)' }}>
          <Link href="/blog" className="hover:underline">Dev Archive</Link>
          <span>·</span>
          <span>Series</span>
          <span>·</span>
          <span>{series.name}</span>
        </div>
      </SectionCard>

      <section>
        <div className="grid gap-4 sm:grid-cols-2">
          {series.posts.map((post, index) => (
            <PostLinkCard
              key={`${post.category}-${post.slug}`}
              post={post}
              label={index === 0 ? '시리즈 시작점' : `${index + 1}번째 글`}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
