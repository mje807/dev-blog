import { cache } from 'react';
import { CATEGORIES } from '@/lib/content/categories';
import { listAllSlugs, readAllPostFiles, readPostFile } from '@/lib/content/repository';
import { renderMarkdownToHtml } from '@/lib/content/render';
import type { CategoryKey } from '@/lib/content/categories';
import type { PostDetail, PostSummary } from '@/lib/content/schema';
import { normalizePostDetail, normalizePostSummary } from '@/lib/content/transform';

export { CATEGORIES };
export type Post = PostSummary;

interface PostIndex {
  allPosts: PostSummary[];
  postsByCategory: Record<string, PostSummary[]>;
  categoryCounts: Record<string, number>;
  slugs: { category: CategoryKey; slug: string }[];
  featuredPosts: PostSummary[];
}

function sortPosts(posts: PostSummary[]): PostSummary[] {
  return [...posts].sort((a, b) => {
    if (a.date < b.date) return 1;
    if (a.date > b.date) return -1;
    return 0;
  });
}

const buildPostIndex = cache((): PostIndex => {
  const allPosts = sortPosts(
    readAllPostFiles()
      .map(normalizePostSummary)
      .filter((post) => !post.draft),
  );

  const postsByCategory: Record<string, PostSummary[]> = {};
  const categoryCounts: Record<string, number> = {};

  for (const post of allPosts) {
    if (!postsByCategory[post.category]) {
      postsByCategory[post.category] = [];
    }

    postsByCategory[post.category].push(post);
    categoryCounts[post.category] = (categoryCounts[post.category] || 0) + 1;
  }

  return {
    allPosts,
    postsByCategory,
    categoryCounts,
    slugs: listAllSlugs().filter(({ category, slug }) => {
      return allPosts.some((post) => post.category === category && post.slug === slug);
    }),
    featuredPosts: allPosts.filter((post) => post.featured),
  };
});

export const getAllPosts = cache((): PostSummary[] => {
  return buildPostIndex().allPosts;
});

export const getPostsByCategory = cache((category: string): PostSummary[] => {
  return buildPostIndex().postsByCategory[category] || [];
});

export const getCategoryCounts = cache((): Record<string, number> => {
  return buildPostIndex().categoryCounts;
});

export const getFeaturedPosts = cache((): PostSummary[] => {
  return buildPostIndex().featuredPosts;
});

export const getAllSlugs = cache(() => {
  return buildPostIndex().slugs;
});

export const getPostContent = cache(async (category: string, slug: string): Promise<PostDetail | null> => {
  const postFile = readPostFile(category, slug);
  if (!postFile) return null;

  const content = await renderMarkdownToHtml(postFile.rawContent);
  const post = normalizePostDetail({ ...postFile, content });
  return post.draft ? null : post;
});

export const getAdjacentPosts = cache((category: string, slug: string): { previous: PostSummary | null; next: PostSummary | null } => {
  const posts = getPostsByCategory(category);
  const index = posts.findIndex((post) => post.slug === slug);

  if (index === -1) {
    return { previous: null, next: null };
  }

  return {
    previous: posts[index + 1] || null,
    next: posts[index - 1] || null,
  };
});

export const getRelatedPosts = cache((category: string, slug: string, limit = 3): PostSummary[] => {
  const current = getPostsByCategory(category).find((post) => post.slug === slug);
  if (!current) return [];

  const related = getAllPosts()
    .filter((post) => !(post.category === current.category && post.slug === current.slug))
    .map((post) => {
      const sharedTags = post.tags.filter((tag) => current.tags.includes(tag)).length;
      const sameCategoryBonus = post.category === current.category ? 2 : 0;
      const sameSeriesBonus = current.series && post.series === current.series ? 3 : 0;
      return {
        post,
        score: sharedTags + sameCategoryBonus + sameSeriesBonus,
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || (a.post.date < b.post.date ? 1 : -1))
    .slice(0, limit)
    .map((entry) => entry.post);

  if (related.length >= limit) {
    return related;
  }

  const fallback = getPostsByCategory(category)
    .filter((post) => post.slug !== slug)
    .slice(0, limit - related.length);

  return [...related, ...fallback.filter((post) => !related.some((item) => item.slug === post.slug && item.category === post.category))];
});
