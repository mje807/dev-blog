import type { PostFrontmatter } from '@/lib/content/schema';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidDateString(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

export function validateAndNormalizeFrontmatter(input: unknown): PostFrontmatter {
  if (!input || typeof input !== 'object') {
    return {};
  }

  const frontmatter = input as Record<string, unknown>;
  const normalized: PostFrontmatter = {};

  if (isNonEmptyString(frontmatter.title)) {
    normalized.title = frontmatter.title.trim();
  }

  if (isNonEmptyString(frontmatter.date) && isValidDateString(frontmatter.date)) {
    normalized.date = frontmatter.date.trim();
  }

  if (Array.isArray(frontmatter.tags)) {
    normalized.tags = frontmatter.tags
      .filter(isNonEmptyString)
      .map((tag) => tag.trim())
      .filter(Boolean);
  }

  if (isNonEmptyString(frontmatter.excerpt)) {
    normalized.excerpt = frontmatter.excerpt.trim();
  }

  return normalized;
}
