import { describe, expect, it } from 'vitest';
import {
  excerptFromContent,
  normalizePostSummary,
  slugFromFilename,
  titleFromContent,
} from '@/lib/content/transform';

describe('content transform utilities', () => {
  it('creates slug from markdown filename', () => {
    expect(slugFromFilename('react-architecture-01.md')).toBe('react-architecture-01');
  });

  it('extracts title from first h1 and strips markdown formatting', () => {
    const title = titleFromContent('# **React** `Fiber` Overview\n\n본문', 'fallback-file.md');
    expect(title).toBe('React Fiber Overview');
  });

  it('falls back to prettified filename when no h1 exists', () => {
    const title = titleFromContent('본문만 있습니다.', '01-react-server-components.md');
    expect(title).toBe('react server components');
  });

  it('creates excerpt from first meaningful paragraph', () => {
    const excerpt = excerptFromContent(`---\ntitle: Test\n---\n\n# Heading\n\n짧음\n\n이 문단은 excerpt로 선택될 만큼 충분히 길고, 카드와 리스트에서 요약으로 사용될 수 있는 문장입니다.\n\n다음 문단`);
    expect(excerpt).toContain('이 문단은 excerpt로 선택될 만큼 충분히 길고');
    expect(excerpt.endsWith('...')).toBe(true);
  });

  it('returns fallback excerpt for empty content', () => {
    expect(excerptFromContent('')).toBe('아직 요약이 준비되지 않았습니다.');
  });

  it('normalizes summary with frontmatter fallbacks', () => {
    const summary = normalizePostSummary({
      slug: 'sample-post',
      category: 'react',
      frontmatter: {},
      rawContent: '# 제목\n\n본문이 충분히 길어서 excerpt 자동 생성이 가능합니다.',
    });

    expect(summary.title).toBe('제목');
    expect(summary.date).toBe('2025-01-01');
    expect(summary.tags).toEqual([]);
    expect(summary.excerpt).toContain('본문이 충분히 길어서 excerpt 자동 생성이 가능합니다.');
  });
});
