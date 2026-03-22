import type { PostDetail, PostFrontmatter, PostSummary } from '@/lib/content/schema';
import type { CategoryKey } from '@/lib/content/categories';

const FALLBACK_DATE = '2025-01-01';

export function slugFromFilename(filename: string): string {
  return filename.replace(/\.md$/, '');
}

export function titleFromContent(content: string, filename: string): string {
  const h1Match = content.match(/^#\s+(.+)$/m);
  if (h1Match) {
    return h1Match[1]
      .replace(/\*\*/g, '')
      .replace(/`/g, '')
      .trim()
      .substring(0, 80);
  }

  return filename
    .replace(/\.md$/, '')
    .replace(/-/g, ' ')
    .replace(/^\d+\s*/, '')
    .trim();
}

export function excerptFromContent(content: string): string {
  const cleaned = content
    .replace(/^---[\s\S]*?---\n/m, '')
    .replace(/^#{1,6}\s+.+$/gm, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^\s*>\s*/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')
    .trim();

  const paragraphs = cleaned.split(/\n\n+/).filter((paragraph) => paragraph.trim().length > 30);
  const excerpt = (paragraphs[0] || '').trim().substring(0, 150);
  return excerpt ? `${excerpt}...` : '아직 요약이 준비되지 않았습니다.';
}

export function normalizePostSummary(input: {
  slug: string;
  category: CategoryKey;
  frontmatter: PostFrontmatter;
  rawContent: string;
}): PostSummary {
  const { slug, category, frontmatter, rawContent } = input;
  return {
    slug,
    category,
    title: frontmatter.title || titleFromContent(rawContent, slug),
    date: frontmatter.date || FALLBACK_DATE,
    tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : [],
    excerpt: frontmatter.excerpt || excerptFromContent(rawContent),
    draft: frontmatter.draft === true,
    featured: frontmatter.featured === true,
    series: frontmatter.series,
  };
}

export function normalizePostDetail(input: {
  slug: string;
  category: CategoryKey;
  frontmatter: PostFrontmatter;
  rawContent: string;
  content: string;
}): PostDetail {
  const summary = normalizePostSummary(input);
  return {
    ...summary,
    content: input.content,
  };
}
