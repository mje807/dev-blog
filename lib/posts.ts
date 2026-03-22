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
}

const buildPostIndex = cache((): PostIndex => {
  const allPosts = readAllPostFiles()
    .map(normalizePostSummary)
    .sort((a, b) => {
      if (a.date < b.date) return 1;
      if (a.date > b.date) return -1;
      return 0;
    });

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
    slugs: listAllSlugs(),
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

export const getAllSlugs = cache(() => {
  return buildPostIndex().slugs;
});

export const getPostContent = cache(async (category: string, slug: string): Promise<PostDetail | null> => {
  const postFile = readPostFile(category, slug);
  if (!postFile) return null;

  const content = await renderMarkdownToHtml(postFile.rawContent);
  return normalizePostDetail({ ...postFile, content });
});
