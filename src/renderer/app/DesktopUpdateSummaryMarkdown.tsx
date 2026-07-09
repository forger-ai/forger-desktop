import { alpha, Box } from '@mui/material';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ExternalMarkdownLink } from '@renderer/components/ExternalMarkdownLink';

interface DesktopUpdateSummaryMarkdownProps {
  content: string;
  onOpenExternalUrl: (url: string) => void;
}

export function DesktopUpdateSummaryMarkdown({
  content,
  onOpenExternalUrl,
}: DesktopUpdateSummaryMarkdownProps) {
  return (
    <Box
      sx={(theme) => ({
        color: 'text.secondary',
        fontSize: theme.typography.body2.fontSize,
        lineHeight: 1.55,
        overflowWrap: 'anywhere',
        wordBreak: 'break-word',
        '& > :first-child': { mt: 0 },
        '& > :last-child': { mb: 0 },
        '& p': { my: 0.5 },
        '& ul, & ol': { my: 0.5, pl: 2.25 },
        '& li': { mb: 0.35 },
        '& h1, & h2, & h3, & h4': {
          color: 'text.primary',
          fontSize: theme.typography.subtitle2.fontSize,
          lineHeight: 1.25,
          mt: 1,
          mb: 0.5,
        },
        '& code': {
          bgcolor: alpha(theme.palette.text.primary, 0.08),
          borderRadius: 0.75,
          color: 'text.primary',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
          fontSize: '0.88em',
          px: 0.5,
          py: 0.1,
        },
        '& a': {
          color: 'primary.main',
          fontWeight: 500,
          textUnderlineOffset: '2px',
        },
        '& blockquote': {
          borderLeft: `3px solid ${theme.palette.divider}`,
          ml: 0,
          my: 0.75,
          pl: 1.25,
        },
      })}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <ExternalMarkdownLink href={href} onOpenExternalUrl={onOpenExternalUrl}>
              {children}
            </ExternalMarkdownLink>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </Box>
  );
}
