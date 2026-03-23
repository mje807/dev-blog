import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getPostContent, getAllSlugs, CATEGORIES, getAdjacentPosts, getRelatedPosts, getSeriesPostsForPost } from '@/lib/posts';
import BlogContent from '@/components/BlogContent';
import PageHeader from '@/components/ui/PageHeader';
import SectionCard from '@/components/ui/SectionCard';
import PostLinkCard from '@/components/PostLinkCard';

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
    title: post.title,
    description: post.excerpt,
  };
}

export default async function PostPage({ params }: Props) {
  const { category, slug } = await params;
  const post = await getPostContent(category, slug);
  if (!post) notFound();

  const categoryMeta = CATEGORIES[post.category];
  const adjacent = getAdjacentPosts(post.category, post.slug);
  const relatedPosts = getRelatedPosts(post.category, post.slug, 3);
  const seriesPosts = getSeriesPostsForPost(post.category, post.slug);
  const seriesSlug = post.series
    ? post.series
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9가-힣]+/g, '-')
      .replace(/^-+|-+$/g, '')
    : null;

  return (
    <article className="max-w-3xl mx-auto">
      <SectionCard className="mb-8">
        <nav className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-muted)' }}>
          <Link href="/" className="hover:underline">Home</Link>
          <span>/</span>
          <Link href="/blog" className="hover:underline">Dev Archive</Link>
          <span>/</span>
          <Link href={`/blog/${post.category}`} className="hover:underline">
            {categoryMeta?.label || post.category}
          </Link>
        </nav>
      </SectionCard>

      <PageHeader
        title={post.title}
        subtitle={
          <span>
            {new Date(post.date).toLocaleDateString('ko-KR', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })}
            {post.series ? ` · 시리즈: ${post.series}` : ''}
            {post.featured ? ' · Featured' : ''}
          </span>
        }
        right={<span className={`text-xs font-medium px-2 py-0.5 rounded-full ${categoryMeta?.color || 'bg-gray-100 text-gray-800'}`}>{categoryMeta?.label || post.category}</span>}
      />

      {post.tags.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-10">
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

      {post.series && (
        <SectionCard className="mb-8">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.16em] mb-2" style={{ color: 'var(--accent)' }}>
                Series
              </div>
              <div className="font-semibold" style={{ color: 'var(--text)' }}>{post.series}</div>
              <div className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
                이 글은 시리즈 흐름 안에 포함되어 있습니다.
              </div>
            </div>
            {seriesSlug && (
              <Link href={`/blog/series/${seriesSlug}`} className="px-4 py-2 rounded-lg text-sm border" style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}>
                시리즈 전체 보기
              </Link>
            )}
          </div>
        </SectionCard>
      )}

      <BlogContent html={post.content || ''} />

      {seriesPosts.length > 0 && (
        <section className="mt-16">
          <h2 className="text-lg font-bold mb-4" style={{ color: 'var(--text)' }}>같은 시리즈</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {seriesPosts.slice(0, 4).map((seriesPost) => (
              <PostLinkCard
                key={`${seriesPost.category}-${seriesPost.slug}`}
                post={seriesPost}
                label="시리즈 글"
              />
            ))}
          </div>
        </section>
      )}

      {(adjacent.previous || adjacent.next) && (
        <section className="mt-16">
          <h2 className="text-lg font-bold mb-4" style={{ color: 'var(--text)' }}>같은 흐름에서 이어 읽기</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {adjacent.previous ? <PostLinkCard post={adjacent.previous} label="이전 글" /> : <div />}
            {adjacent.next ? <PostLinkCard post={adjacent.next} label="다음 글" /> : <div />}
          </div>
        </section>
      )}

      {relatedPosts.length > 0 && (
        <section className="mt-12">
          <h2 className="text-lg font-bold mb-4" style={{ color: 'var(--text)' }}>관련 글</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {relatedPosts.map((relatedPost) => (
              <PostLinkCard
                key={`${relatedPost.category}-${relatedPost.slug}`}
                post={relatedPost}
                label={relatedPost.series && relatedPost.series === post.series ? '같은 시리즈' : '관련 글'}
              />
            ))}
          </div>
        </section>
      )}

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
