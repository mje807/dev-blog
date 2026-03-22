'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import useMotionPreset from '@/app/design/useMotionPreset';
import { CATEGORIES } from '@/lib/content/categories';

interface PostLike {
  slug: string;
  category: string;
  title: string;
  date: string;
  tags: string[];
  excerpt: string;
  featured?: boolean;
  series?: string;
}

type ViewMode = 'card' | 'list';
type SortMode = 'latest' | 'oldest' | 'title' | 'readShort' | 'readLong';
type FilterMode = 'all' | 'featured';

function estimateReadMinutes(text: string): number {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').length;
  return Math.max(3, Math.round(words / 220));
}

export default function BlogPostBrowser({ posts }: { posts: PostLike[] }) {
  const [viewMode, setViewMode] = useState<ViewMode>('card');
  const [sortMode, setSortMode] = useState<SortMode>('latest');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [selectedTag, setSelectedTag] = useState<string>('all');
  const [query, setQuery] = useState('');

  const { style: motionStyle } = useMotionPreset('quick', 'background-color, border-color, color, opacity, transform');

  const tags = useMemo(() => {
    const map = new Map<string, number>();
    for (const post of posts) {
      for (const tag of post.tags) {
        map.set(tag, (map.get(tag) || 0) + 1);
      }
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko'));
  }, [posts]);

  const sorted = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const list = posts.filter((post) => {
      if (filterMode === 'featured' && !post.featured) return false;
      if (selectedTag !== 'all' && !post.tags.includes(selectedTag)) return false;
      if (!normalizedQuery) return true;

      const haystack = `${post.title} ${post.excerpt} ${post.tags.join(' ')} ${post.series || ''}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    });

    list.sort((a, b) => {
      if (sortMode === 'latest') return a.date < b.date ? 1 : -1;
      if (sortMode === 'oldest') return a.date > b.date ? 1 : -1;
      if (sortMode === 'title') return a.title.localeCompare(b.title, 'ko');
      const ra = estimateReadMinutes(`${a.title} ${a.excerpt}`);
      const rb = estimateReadMinutes(`${b.title} ${b.excerpt}`);
      if (sortMode === 'readShort') return ra - rb;
      return rb - ra;
    });
    return list;
  }, [posts, sortMode, filterMode, selectedTag, query]);

  return (
    <>
      <div className="space-y-4 mb-5">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          <div className="inline-flex rounded-lg border overflow-hidden" style={{ borderColor: 'var(--border)' }}>
            <button
              onClick={() => setViewMode('card')}
              className="px-3 py-1.5 text-sm"
              style={{ ...motionStyle, background: viewMode === 'card' ? 'var(--accent)' : 'transparent', color: viewMode === 'card' ? '#0f1117' : 'var(--text-muted)' }}
            >
              카드형
            </button>
            <button
              onClick={() => setViewMode('list')}
              className="px-3 py-1.5 text-sm"
              style={{ ...motionStyle, background: viewMode === 'list' ? 'var(--accent)' : 'transparent', color: viewMode === 'list' ? '#0f1117' : 'var(--text-muted)' }}
            >
              리스트형
            </button>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="inline-flex rounded-lg border overflow-hidden" style={{ borderColor: 'var(--border)' }}>
              <button
                onClick={() => setFilterMode('all')}
                className="px-3 py-1.5 text-sm"
                style={{ ...motionStyle, background: filterMode === 'all' ? 'var(--accent)' : 'transparent', color: filterMode === 'all' ? '#0f1117' : 'var(--text-muted)' }}
              >
                전체
              </button>
              <button
                onClick={() => setFilterMode('featured')}
                className="px-3 py-1.5 text-sm"
                style={{ ...motionStyle, background: filterMode === 'featured' ? 'var(--accent)' : 'transparent', color: filterMode === 'featured' ? '#0f1117' : 'var(--text-muted)' }}
              >
                Featured
              </button>
            </div>

            <div className="flex items-center gap-2 text-sm">
              <span style={{ color: 'var(--text-muted)' }}>정렬</span>
              <select
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value as SortMode)}
                className="px-2 py-1.5 rounded border"
                style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-card)', color: 'var(--text)' }}
              >
                <option value="latest">최신순</option>
                <option value="oldest">오래된순</option>
                <option value="title">제목순</option>
                <option value="readShort">읽기시간 짧은순</option>
                <option value="readLong">읽기시간 긴순</option>
              </select>
            </div>
          </div>
        </div>

        <div className="flex flex-col lg:flex-row lg:items-center gap-3">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="제목, 요약, 태그, 시리즈 검색"
            className="w-full lg:max-w-sm px-3 py-2 rounded-lg border text-sm"
            style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-card)', color: 'var(--text)' }}
          />
          <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
            {sorted.length}개 결과
          </div>
        </div>

        {tags.length > 0 && (
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setSelectedTag('all')}
              className="px-3 py-1.5 rounded-lg text-sm border"
              style={selectedTag === 'all'
                ? { ...motionStyle, borderColor: 'var(--accent)', color: 'var(--accent)', backgroundColor: 'rgba(99,179,237,0.1)' }
                : { ...motionStyle, borderColor: 'var(--border)', color: 'var(--text-muted)', backgroundColor: 'var(--bg-card)' }}
            >
              전체 태그
            </button>
            {tags.map(([tag, count]) => (
              <button
                key={tag}
                onClick={() => setSelectedTag(tag)}
                className="px-3 py-1.5 rounded-lg text-sm border"
                style={selectedTag === tag
                  ? { ...motionStyle, borderColor: 'var(--accent)', color: 'var(--accent)', backgroundColor: 'rgba(99,179,237,0.1)' }
                  : { ...motionStyle, borderColor: 'var(--border)', color: 'var(--text-muted)', backgroundColor: 'var(--bg-card)' }}
              >
                #{tag} ({count})
              </button>
            ))}
          </div>
        )}
      </div>

      {sorted.length === 0 ? (
        <div className="rounded-xl border p-6 text-sm leading-6" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-card)', color: 'var(--text-muted)' }}>
          현재 필터 조건에 맞는 글이 없습니다. 태그나 검색어를 바꿔보세요.
        </div>
      ) : viewMode === 'card' ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {sorted.map((post) => {
            const href = `/blog/${post.category}/${post.slug}`;
            const category = CATEGORIES[post.category];
            const readMins = estimateReadMinutes(`${post.title} ${post.excerpt}`);
            return (
              <Link key={`${post.category}-${post.slug}`} href={href} className="block group rounded-xl border p-5" style={{ ...motionStyle, borderColor: 'var(--border)', backgroundColor: 'var(--bg-card)' }}>
                <div className="flex items-center gap-2 mb-3 flex-wrap">
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${category?.color || 'bg-gray-100 text-gray-800'}`}>
                    {category?.label || post.category}
                  </span>
                  {post.featured && (
                    <span className="text-xs font-medium px-2 py-0.5 rounded-full border" style={{ borderColor: 'var(--accent)', color: 'var(--accent)', backgroundColor: 'rgba(99,179,237,0.1)' }}>
                      Featured
                    </span>
                  )}
                  {post.series && (
                    <span className="text-xs font-medium px-2 py-0.5 rounded-full border" style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}>
                      Series
                    </span>
                  )}
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {new Date(post.date).toLocaleDateString('ko-KR')}
                  </span>
                </div>
                <h3 className="font-bold mb-2 line-clamp-2" style={{ color: 'var(--text)' }}>{post.title}</h3>
                <p className="text-sm line-clamp-2" style={{ color: 'var(--text-muted)' }}>{post.excerpt}</p>
                {post.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-3">
                    {post.tags.slice(0, 3).map((tag) => (
                      <span key={tag} className="text-xs px-1.5 py-0.5 rounded" style={{ backgroundColor: 'rgba(148,163,184,0.12)', color: 'var(--text-muted)' }}>
                        #{tag}
                      </span>
                    ))}
                  </div>
                )}
                <div className="text-xs mt-3" style={{ color: 'var(--text-muted)' }}>⏱️ {readMins}분</div>
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border)' }}>
          {sorted.map((post) => {
            const href = `/blog/${post.category}/${post.slug}`;
            const category = CATEGORIES[post.category];
            const readMins = estimateReadMinutes(`${post.title} ${post.excerpt}`);
            return (
              <Link key={`${post.category}-${post.slug}`} href={href} className="block border-b last:border-b-0 px-4 py-3 hover:opacity-90" style={{ ...motionStyle, borderColor: 'var(--border)' }}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-semibold truncate" style={{ color: 'var(--text)' }}>{post.title}</div>
                    <div className="text-sm mt-1 line-clamp-1" style={{ color: 'var(--text-muted)' }}>{post.excerpt}</div>
                  </div>
                  <div className="text-xs whitespace-nowrap text-right" style={{ color: 'var(--text-muted)' }}>
                    <div>{new Date(post.date).toLocaleDateString('ko-KR')}</div>
                    <div>⏱️ {readMins}분</div>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${category?.color || 'bg-gray-100 text-gray-800'}`}>
                    {category?.label || post.category}
                  </span>
                  {post.featured && (
                    <span className="text-xs font-medium px-2 py-0.5 rounded-full border" style={{ borderColor: 'var(--accent)', color: 'var(--accent)', backgroundColor: 'rgba(99,179,237,0.1)' }}>
                      Featured
                    </span>
                  )}
                  {post.tags.slice(0, 2).map((tag) => (
                    <span key={tag} className="text-xs px-2 py-0.5 rounded-full border" style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}>
                      #{tag}
                    </span>
                  ))}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}
