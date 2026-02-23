'use client';

import { useEffect, useRef } from 'react';

interface BlogContentProps {
  html: string;
}

export default function BlogContent({ html }: BlogContentProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const renderMermaid = async () => {
      if (!containerRef.current) return;

      const mermaidBlocks = containerRef.current.querySelectorAll('pre > code.language-mermaid');
      if (mermaidBlocks.length === 0) return;

      const { default: mermaid } = await import('mermaid');

      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default',
      });

      let index = 0;
      for (const block of mermaidBlocks) {
        const pre = block.parentElement;
        if (!pre || pre.getAttribute('data-mermaid-processed') === 'true') continue;

        const graphDefinition = block.textContent?.trim();
        if (!graphDefinition) continue;

        const wrapper = document.createElement('div');
        wrapper.className = 'mermaid my-6';
        wrapper.textContent = graphDefinition;

        pre.replaceWith(wrapper);
        pre.setAttribute('data-mermaid-processed', 'true');
        index++;
      }

      if (index > 0) {
        await mermaid.run({ nodes: containerRef.current.querySelectorAll('.mermaid') });
      }
    };

    renderMermaid().catch((err) => {
      console.error('Mermaid rendering failed:', err);
    });
  }, [html]);

  return (
    <div
      ref={containerRef}
      className="prose"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
