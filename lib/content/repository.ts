import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { CATEGORIES, isCategoryKey, type CategoryKey } from '@/lib/content/categories';
import type { RawPostFile } from '@/lib/content/schema';
import { slugFromFilename } from '@/lib/content/transform';
import { validateAndNormalizeFrontmatter } from '@/lib/content/validation';

const contentDir = path.join(process.cwd(), 'content');

function getCategoryDir(category: CategoryKey): string {
  return path.join(contentDir, category);
}

export function listCategoryKeys(): CategoryKey[] {
  return Object.keys(CATEGORIES) as CategoryKey[];
}

export function listMarkdownFiles(category: CategoryKey): string[] {
  const categoryDir = getCategoryDir(category);
  if (!fs.existsSync(categoryDir)) return [];
  return fs.readdirSync(categoryDir).filter((file) => file.endsWith('.md'));
}

export function readPostFile(category: string, slug: string): RawPostFile | null {
  if (!isCategoryKey(category)) return null;

  const filePath = path.join(getCategoryDir(category), `${slug}.md`);
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, 'utf-8');
  const { data, content } = matter(raw);

  return {
    slug,
    category,
    frontmatter: validateAndNormalizeFrontmatter(data),
    rawContent: content,
  };
}

export function readAllPostFiles(): RawPostFile[] {
  const posts: RawPostFile[] = [];

  for (const category of listCategoryKeys()) {
    const files = listMarkdownFiles(category);

    for (const file of files) {
      const filePath = path.join(getCategoryDir(category), file);
      const raw = fs.readFileSync(filePath, 'utf-8');
      const { data, content } = matter(raw);

      posts.push({
        slug: slugFromFilename(file),
        category,
        frontmatter: validateAndNormalizeFrontmatter(data),
        rawContent: content,
      });
    }
  }

  return posts;
}

export function listAllSlugs(): { category: CategoryKey; slug: string }[] {
  const slugs: { category: CategoryKey; slug: string }[] = [];

  for (const category of listCategoryKeys()) {
    for (const file of listMarkdownFiles(category)) {
      slugs.push({ category, slug: slugFromFilename(file) });
    }
  }

  return slugs;
}
