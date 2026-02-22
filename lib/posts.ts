import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import remarkHtml from 'remark-html';

const contentDir = path.join(process.cwd(), 'content');

export const CATEGORIES: Record<string, { label: string; color: string }> = {
  'react': { label: 'React', color: 'bg-blue-100 text-blue-800' },
  'frontend-architecture': { label: 'Frontend Architecture', color: 'bg-purple-100 text-purple-800' },
  'software-engineering': { label: 'Software Engineering', color: 'bg-green-100 text-green-800' },
  'ai-skill-design': { label: 'AI Skill Design', color: 'bg-orange-100 text-orange-800' },
  'claude-code': { label: 'Claude Code', color: 'bg-rose-100 text-rose-800' },
  'general': { label: 'General', color: 'bg-gray-100 text-gray-800' },
};

export interface Post {
  slug: string;
  category: string;
  title: string;
  date: string;
  tags: string[];
  excerpt: string;
  content?: string;
}

function slugFromFilename(filename: string): string {
  return filename.replace(/\.md$/, '');
}

function titleFromContent(content: string, filename: string): string {
  // Try to extract first H1
  const h1Match = content.match(/^#\s+(.+)$/m);
  if (h1Match) {
    // Clean markdown syntax from title
    return h1Match[1]
      .replace(/\*\*/g, '')
      .replace(/`/g, '')
      .trim()
      .substring(0, 80);
  }
  // Fallback: prettify filename
  return filename
    .replace(/\.md$/, '')
    .replace(/-/g, ' ')
    .replace(/^\d+\s*/, '')
    .trim();
}

function excerptFromContent(content: string): string {
  // Remove front matter, headings, code blocks, get first paragraph
  const cleaned = content
    .replace(/^---[\s\S]*?---\n/m, '')
    .replace(/^#{1,6}\s+.+$/gm, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^\s*>\s*/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')
    .trim();

  const paragraphs = cleaned.split(/\n\n+/).filter(p => p.trim().length > 30);
  return (paragraphs[0] || '').trim().substring(0, 150) + '...';
}

export function getAllPosts(): Post[] {
  const posts: Post[] = [];

  for (const category of Object.keys(CATEGORIES)) {
    const categoryDir = path.join(contentDir, category);
    if (!fs.existsSync(categoryDir)) continue;

    const files = fs.readdirSync(categoryDir).filter(f => f.endsWith('.md'));

    for (const file of files) {
      const filePath = path.join(categoryDir, file);
      const raw = fs.readFileSync(filePath, 'utf-8');
      const { data, content } = matter(raw);

      const slug = slugFromFilename(file);
      const title = data.title || titleFromContent(content, file);
      const date = data.date || '2025-01-01';
      const tags: string[] = data.tags || [];
      const excerpt = data.excerpt || excerptFromContent(content);

      posts.push({ slug, category, title, date, tags, excerpt });
    }
  }

  return posts.sort((a, b) => {
    if (a.date < b.date) return 1;
    if (a.date > b.date) return -1;
    return 0;
  });
}

export function getPostsByCategory(category: string): Post[] {
  return getAllPosts().filter(p => p.category === category);
}

export async function getPostContent(category: string, slug: string): Promise<Post | null> {
  const filePath = path.join(contentDir, category, `${slug}.md`);
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, 'utf-8');
  const { data, content } = matter(raw);

  const title = data.title || titleFromContent(content, slug);
  const date = data.date || '2025-01-01';
  const tags: string[] = data.tags || [];

  const processedContent = await remark()
    .use(remarkGfm)
    .use(remarkHtml, { sanitize: false })
    .process(content);

  return {
    slug,
    category,
    title,
    date,
    tags,
    excerpt: excerptFromContent(content),
    content: processedContent.toString(),
  };
}

export function getAllSlugs(): { category: string; slug: string }[] {
  const slugs: { category: string; slug: string }[] = [];

  for (const category of Object.keys(CATEGORIES)) {
    const categoryDir = path.join(contentDir, category);
    if (!fs.existsSync(categoryDir)) continue;

    const files = fs.readdirSync(categoryDir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      slugs.push({ category, slug: slugFromFilename(file) });
    }
  }

  return slugs;
}
