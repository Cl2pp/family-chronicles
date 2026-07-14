'use client';

import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import classes from './message-markdown.module.css';

/**
 * Assistant replies arrive as markdown (the model bolds names, lists what it did).
 * Render it instead of showing the raw `**` markers. remark-breaks keeps the old
 * pre-wrap behavior: a single newline in the reply is a visible line break, not a
 * collapsed space. No raw-HTML pass-through — react-markdown escapes it by default.
 */
export function MessageMarkdown({ content }: { content: string }) {
  return (
    <div className={classes.root}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          // The model occasionally links stories or external sites; keep the chat
          // thread (and any in-flight draft card) intact by opening them elsewhere.
          a: (props) => {
            // `node` is react-markdown's AST node, not a DOM attribute — drop it.
            const { node, ...anchorProps } = props;
            void node;
            return <a {...anchorProps} target="_blank" rel="noreferrer" />;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
