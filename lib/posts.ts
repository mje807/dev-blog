import { CATEGORIES } from '@/lib/content/categories';
import { listAllSlugs, readAllPostFiles, readPostFile } from '@/lib/content/repository';
import { renderMarkdownToHtml } from '@/lib/content/render';
import type { PostDetail, PostSummary } from '@/lib/content/schema';
import { normalizePostDetail, normalizePostSummary } from '@/lib/content/transform';

export { CATEGORIES };
export type Post = PostSummary;

export function getAllPosts(): PostSummary[] {
  return readAllPostFiles()
    .map(normalizePostSummary)
    .sort((a, b) => {
      if (a.date < b.date) return 1;
      if (a.date > b.date) return -1;
      return 0;
    });
}

export function getPostsByCategory(category: string): PostSummary[] {
  return getAllPosts().filter((post) => post.category === category);
}

export async function getPostContent(category: string, slug: string): Promise<PostDetail | null> {
  const postFile = readPostFile(category, slug);
  if (!postFile) return null;

  const content = await renderMarkdownToHtml(postFile.rawContent);
  return normalizePostDetail({ ...postFile, content });
}

export function getAllSlugs() {
  return listAllSlugs();
}
