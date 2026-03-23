import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeMermaid from 'rehype-mermaid';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import type { Schema } from 'hast-util-sanitize';

const sanitizeSchema: Schema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames || []),
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'img',
    'pre',
    'code',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'del',
    'hr',
    'div',
  ],
  attributes: {
    ...defaultSchema.attributes,
    a: [...(defaultSchema.attributes?.a || []), 'href', 'title', 'target', 'rel'],
    code: [...(defaultSchema.attributes?.code || []), ['className', /^language-[\w-]+$/]],
    img: [
      ...(defaultSchema.attributes?.img || []),
      'src',
      'alt',
      'title',
      'width',
      'height',
      'loading',
    ],
    div: [...(defaultSchema.attributes?.div || []), 'className'],
    pre: [...(defaultSchema.attributes?.pre || []), 'className'],
  },
};

export async function renderMarkdownToHtml(markdown: string): Promise<string> {
  const processedContent = await remark()
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeMermaid, {
      strategy: 'pre-mermaid',
      errorFallback: (_element: unknown, diagram: string) => ({
        type: 'element',
        tagName: 'pre',
        properties: { className: ['mermaid-fallback'] },
        children: [
          {
            type: 'text',
            value: diagram,
          },
        ],
      }),
    })
    .use(rehypeSanitize, sanitizeSchema)
    .use(rehypeStringify)
    .process(markdown);

  return processedContent.toString();
}
