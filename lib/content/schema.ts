import type { CategoryKey } from '@/lib/content/categories';

export interface PostFrontmatter {
  title?: string;
  date?: string;
  tags?: string[];
  excerpt?: string;
}

export interface PostSummary {
  slug: string;
  category: CategoryKey;
  title: string;
  date: string;
  tags: string[];
  excerpt: string;
}

export interface PostDetail extends PostSummary {
  content: string;
}

export interface RawPostFile {
  slug: string;
  category: CategoryKey;
  frontmatter: PostFrontmatter;
  rawContent: string;
}
