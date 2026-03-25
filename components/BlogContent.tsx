'use client';

import { useEffect, useMemo, useState } from 'react';
import parse, { type HTMLReactParserOptions } from 'html-react-parser';
import type { Element as DomElement, DataNode } from 'domhandler';
import MermaidDiagram from '@/components/MermaidDiagram';

interface BlogContentProps {
  html: string;
}

interface QuickView {
  intro: string;
  sections: string[];
  bullets: string[];
}

export default function BlogContent({ html }: BlogContentProps) {
  const [mode, setMode] = useState<'deep' | 'quick'>('deep');
  const [quickView, setQuickView] = useState<QuickView>({ intro: '', sections: [], bullets: [] });

  useEffect(() => {
    if (!html || typeof document === 'undefined') {
      setQuickView({ intro: '', sections: [], bullets: [] });
      return;
    }

    const el = document.createElement('div');
    el.innerHTML = html;

    const firstParagraph = el.querySelector('p')?.textContent?.trim() || '';
    const sectionTitles = Array.from(el.querySelectorAll('h2'))
      .map((h) => h.textContent?.trim() || '')
      .filter(Boolean)
      .slice(0, 8);

    const bullets = Array.from(el.querySelectorAll('ul li'))
      .map((li) => li.textContent?.trim() || '')
      .filter(Boolean)
      .slice(0, 5);

    setQuickView({
      intro: firstParagraph,
      sections: sectionTitles,
      bullets,
    });
  }, [html]);

  const deepContent = useMemo(() => {
    const options: HTMLReactParserOptions = {
      replace: (domNode) => {
        if (domNode.type !== 'tag') return undefined;

        const element = domNode as DomElement;
        const classAttr = element.attribs?.class || element.attribs?.className || '';
        const classNames = classAttr.split(/\s+/).filter(Boolean);

        if (element.name === 'pre' && classNames.includes('mermaid')) {
          const code = (element.children || [])
            .map((child) => ('data' in child ? (child as DataNode).data : ''))
            .join('')
            .trim();

          if (!code) return null;
          return <MermaidDiagram code={code} />;
        }

        if (element.attribs && element.attribs.class) {
          element.attribs.className = element.attribs.class;
          delete element.attribs.class;
        }

        return undefined;
      },
    };

    return parse(html, options);
  }, [html]);

  return (
    <div>
      <div className="reader-mode-bar">
        <span className="reader-mode-label">독자 모드</span>
        <div className="reader-mode-buttons">
          <button
            className={`reader-mode-btn ${mode === 'quick' ? 'active' : ''}`}
            onClick={() => setMode('quick')}
            type="button"
          >
            빠르게 읽기
          </button>
          <button
            className={`reader-mode-btn ${mode === 'deep' ? 'active' : ''}`}
            onClick={() => setMode('deep')}
            type="button"
          >
            깊게 읽기
          </button>
        </div>
      </div>

      {mode === 'quick' ? (
        <section className="quick-view-card">
          <h3>핵심 요약</h3>
          {quickView.intro && <p>{quickView.intro}</p>}

          {quickView.sections.length > 0 && (
            <>
              <h4>섹션 미리보기</h4>
              <ul>
                {quickView.sections.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </>
          )}

          {quickView.bullets.length > 0 && (
            <>
              <h4>핵심 포인트</h4>
              <ul>
                {quickView.bullets.map((b, idx) => (
                  <li key={`${idx}-${b.slice(0, 20)}`}>{b}</li>
                ))}
              </ul>
            </>
          )}

          <p className="quick-hint">상세 분석과 다이어그램은 ‘깊게 읽기’에서 볼 수 있습니다.</p>
        </section>
      ) : (
        <div className="prose">{deepContent}</div>
      )}
    </div>
  );
}
