'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import useMotionPreset from '@/app/design/useMotionPreset';

interface PostLike {
  slug: string;
  category: string;
  title: string;
  date: string;
  tags: string[];
  excerpt: string;
}

const CATEGORIES: Record<string, { label: string; color: string }> = {
  react: { label: 'React', color: 'bg-blue-100 text-blue-800' },
  'frontend-architecture': { label: 'Frontend Architecture', color: 'bg-purple-100 text-purple-800' },
  'software-engineering': { label: 'Software Engineering', color: 'bg-green-100 text-green-800' },
  'ai-skill-design': { label: 'AI Skill Design', color: 'bg-orange-100 text-orange-800' },
  'claude-code': { label: 'Claude Code', color: 'bg-rose-100 text-rose-800' },
  general: { label: 'General', color: 'bg-gray-100 text-gray-800' },
};

type ViewMode = 'card' | 'list';
type SortMode = 'latest' | 'oldest' | 'title' | 'readShort' | 'readLong';

function estimateReadMinutes(text: string): number {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').length;
  return Math.max(3, Math.round(words / 220));
}

export default function BlogPostBrowser({ posts }: { posts: PostLike[] }) {
  const [viewMode, setViewMode] = useState<ViewMode>('card');
  const [sortMode, setSortMode] = useState<SortMode>('latest');

  const { style: motionStyle } = useMotionPreset('quick', 'background-color, border-color, color, opacity, transform');

  const sorted = useMemo(() => {
    const list = [...posts];
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
  }, [posts, sortMode]);

  return (
    <>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-5">
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

      {viewMode === 'card' ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {sorted.map((post) => {
            const href = `/blog/${post.category}/${post.slug}`;
            const category = CATEGORIES[post.category];
            const readMins = estimateReadMinutes(`${post.title} ${post.excerpt}`);
            return (
              <Link key={`${post.category}-${post.slug}`} href={href} className="block group rounded-xl border p-5" style={{ ...motionStyle, borderColor: 'var(--border)', backgroundColor: 'var(--bg-card)' }}>
                <div className="flex items-center gap-2 mb-3">
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${category?.color || 'bg-gray-100 text-gray-800'}`}>
                    {category?.label || post.category}
                  </span>
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {new Date(post.date).toLocaleDateString('ko-KR')}
                  </span>
                </div>
                <h3 className="font-bold mb-2 line-clamp-2" style={{ color: 'var(--text)' }}>{post.title}</h3>
                <p className="text-sm line-clamp-2" style={{ color: 'var(--text-muted)' }}>{post.excerpt}</p>
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
                <div className="mt-2">
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${category?.color || 'bg-gray-100 text-gray-800'}`}>
                    {category?.label || post.category}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}
