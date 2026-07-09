import { alpha, Box, useTheme } from '@mui/material';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ExternalMarkdownLink } from '@renderer/components/ExternalMarkdownLink';

export function MarkdownMessage({ content }: { content: string }) {
  const theme = useTheme();
  const codeBackground = theme.palette.mode === 'dark'
    ? alpha(theme.palette.common.white, 0.08)
    : theme.palette.action.hover;
  const preBackground = theme.palette.mode === 'dark'
    ? alpha(theme.palette.common.white, 0.06)
    : theme.palette.background.default;

  return (
    <Box
      sx={{
        fontSize: theme.typography.body2.fontSize,
        lineHeight: 1.55,
        maxWidth: '100%',
        minWidth: 0,
        overflowWrap: 'anywhere',
        wordBreak: 'break-word',
        '& > :first-child': { mt: 0 },
        '& > :last-child': { mb: 0 },
        '& h1, & h2, & h3, & h4': {
          mt: 1.2,
          mb: 0.9,
          lineHeight: 1.15,
          overflowWrap: 'anywhere',
          wordBreak: 'break-word',
        },
        '& h1:first-of-type, & h2:first-of-type, & h3:first-of-type, & h4:first-of-type': {
          mt: 0,
        },
        '& p': { my: 0.7, lineHeight: 1.55, fontSize: 'inherit', overflowWrap: 'anywhere', wordBreak: 'break-word' },
        '& ul, & ol': { my: 0.8, pl: 2.5, minWidth: 0 },
        '& li': { mb: 0.45, fontSize: 'inherit', overflowWrap: 'anywhere', wordBreak: 'break-word' },
        '& a': {
          color: theme.palette.primary.main,
          textDecorationColor: theme.palette.primary.main,
          textUnderlineOffset: '2px',
          fontWeight: 500,
          transition: 'color 120ms ease',
          overflowWrap: 'anywhere',
          wordBreak: 'break-word',
        },
        '& a:hover': {
          color: theme.palette.primary.light,
        },
        '& code': {
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
          bgcolor: codeBackground,
          color: 'text.primary',
          px: 0.5,
          py: 0.15,
          borderRadius: 1,
          fontSize: '0.88em',
          whiteSpace: 'break-spaces',
          overflowWrap: 'anywhere',
          wordBreak: 'break-word',
        },
        '& pre': {
          bgcolor: preBackground,
          border: `1px solid ${theme.palette.divider}`,
          borderRadius: 2,
          p: 1.25,
          maxWidth: '100%',
          overflowX: 'auto',
          overflowY: 'hidden',
          my: 1,
        },
        '& pre code': {
          bgcolor: 'transparent',
          p: 0,
          borderRadius: 0,
          whiteSpace: 'pre',
          overflowWrap: 'normal',
          wordBreak: 'normal',
        },
        '& table': {
          display: 'block',
          maxWidth: '100%',
          overflowX: 'auto',
          borderCollapse: 'collapse',
          my: 1,
        },
        '& th, & td': {
          border: `1px solid ${theme.palette.divider}`,
          px: 1,
          py: 0.75,
          verticalAlign: 'top',
        },
        '& img, & video': {
          maxWidth: '100%',
          height: 'auto',
        },
        '& blockquote': {
          my: 1,
          pl: 1.5,
          ml: 0,
          borderLeft: `3px solid ${theme.palette.divider}`,
          color: 'text.secondary',
          fontSize: 'inherit',
        },
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <ExternalMarkdownLink href={href}>{children}</ExternalMarkdownLink>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </Box>
  );
}
