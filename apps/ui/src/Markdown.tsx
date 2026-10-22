import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown text-pretty">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children: text, href }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {text}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
