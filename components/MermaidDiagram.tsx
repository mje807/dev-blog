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
          theme: 'base',
          fontFamily: 'Pretendard, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
          themeVariables: {
            background: '#121a27',
            primaryColor: '#1d2a3d',
            primaryTextColor: '#e2e8f0',
            primaryBorderColor: '#4a627d',
            lineColor: '#94a3b8',
            secondaryColor: '#1f2937',
            tertiaryColor: '#2a1f3d',
            mainBkg: '#1d2a3d',
            secondBkg: '#1f2937',
            tertiaryBkg: '#2a1f3d',
            textColor: '#e2e8f0',
            nodeTextColor: '#e2e8f0',
            edgeLabelBackground: '#121a27',
            clusterBkg: '#151f30',
            clusterBorder: '#3d536b',
            titleColor: '#d6ecff',
            actorBorder: '#4a627d',
            actorBkg: '#1d2a3d',
            actorTextColor: '#e2e8f0',
            labelBoxBkgColor: '#121a27',
            labelBoxBorderColor: '#3d536b',
            labelTextColor: '#e2e8f0',
            loopTextColor: '#e2e8f0',
            noteBkgColor: '#1f2937',
            noteBorderColor: '#4a627d',
            noteTextColor: '#dbe7f5',
            activationBorderColor: '#63b3ed',
            activationBkgColor: '#15304d',
            sequenceNumberColor: '#0f1117',
          },
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
