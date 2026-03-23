'use client';

import RenderMermaid from 'react-x-mermaid';

export default function MermaidDiagram({ code }: { code: string }) {
  return (
    <div className="diagram-card">
      <div className="diagram-label">Architecture Diagram</div>
      <RenderMermaid
        mermaidCode={code}
        disableCopy
        disableDownload
        mermaidConfig={{
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'default',
        }}
        renderCode={({ code: fallbackCode }) => (
          <pre className="mermaid-fallback">
            <code>{fallbackCode}</code>
          </pre>
        )}
      />
    </div>
  );
}
