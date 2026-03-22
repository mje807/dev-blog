import { describe, expect, it } from 'vitest';
import { renderMarkdownToHtml } from '@/lib/content/render';

describe('markdown render sanitize', () => {
  it('renders safe markdown elements', async () => {
    const html = await renderMarkdownToHtml('# Title\n\n- item\n\n```ts\nconst x = 1;\n```');

    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<li>item</li>');
    expect(html).toContain('<code class="language-ts">');
  });

  it('drops raw html payloads under the conservative sanitize policy', async () => {
    const html = await renderMarkdownToHtml('<script>alert(1)</script>\n\n<a href="/x" onclick="alert(1)">link</a>');

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('onclick=');
    expect(html).not.toContain('<a href="/x">link</a>');
    expect(html).toContain('<p>link</p>');
  });
});
