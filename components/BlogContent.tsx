'use client';

import { useEffect, useRef, useState } from 'react';

interface BlogContentProps {
  html: string;
}

interface QuickView {
  intro: string;
  sections: string[];
  bullets: string[];
}

export default function BlogContent({ html }: BlogContentProps) {
  const containerRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    const renderMermaid = async () => {
      if (!containerRef.current || mode !== 'deep') return;

      const mermaidSources = containerRef.current.querySelectorAll('[data-mermaid]');
      if (mermaidSources.length === 0) return;

      const { default: mermaid } = await import('mermaid');

      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default',
      });

      let index = 0;
      for (const source of mermaidSources) {
        if (source.getAttribute('data-mermaid-processed') === 'true') continue;

        const graphDefinition = source.getAttribute('data-mermaid')?.trim();
        if (!graphDefinition) continue;

        const card = document.createElement('div');
        card.className = 'diagram-card';

        const label = document.createElement('div');
        label.className = 'diagram-label';
        label.textContent = source.getAttribute('data-diagram-label') || 'Architecture Diagram';

        const wrapper = document.createElement('div');
        wrapper.className = 'mermaid';
        wrapper.textContent = graphDefinition;

        card.appendChild(label);
        card.appendChild(wrapper);

        source.replaceWith(card);
        source.setAttribute('data-mermaid-processed', 'true');
        index++;
      }

      if (index > 0) {
        await mermaid.run({ nodes: containerRef.current.querySelectorAll('.mermaid') });
      }
    };

    renderMermaid().catch((err) => {
      console.error('Mermaid rendering failed:', err);
    });
  }, [html, mode]);

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
        <div
          ref={containerRef}
          className="prose"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  );
}
