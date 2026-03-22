import { describe, expect, it } from 'vitest';
import { validateAndNormalizeFrontmatter } from '@/lib/content/validation';

describe('frontmatter validation', () => {
  it('returns empty object for non-object input', () => {
    expect(validateAndNormalizeFrontmatter(null)).toEqual({});
    expect(validateAndNormalizeFrontmatter('oops')).toEqual({});
  });

  it('keeps valid fields and trims string values', () => {
    expect(
      validateAndNormalizeFrontmatter({
        title: '  React Server Components  ',
        date: '2026-03-20',
        tags: [' react ', 'rsc', '', 123, null],
        excerpt: '  역할과 경계를 정리합니다.  ',
      }),
    ).toEqual({
      title: 'React Server Components',
      date: '2026-03-20',
      tags: ['react', 'rsc'],
      excerpt: '역할과 경계를 정리합니다.',
    });
  });

  it('drops invalid date and malformed tags', () => {
    expect(
      validateAndNormalizeFrontmatter({
        title: 'Valid title',
        date: 'not-a-date',
        tags: 'react',
        excerpt: '',
      }),
    ).toEqual({
      title: 'Valid title',
    });
  });
});
