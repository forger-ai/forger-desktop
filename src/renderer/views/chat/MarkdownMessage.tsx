import { Box, useTheme } from '@mui/material';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function MarkdownMessage({ content }: { content: string }) {
  const theme = useTheme();

  return (
    <Box
      sx={{
        fontSize: theme.typography.body2.fontSize,
        lineHeight: 1.55,
        '& > :first-child': { mt: 0 },
        '& > :last-child': { mb: 0 },
        '& h1, & h2, & h3, & h4': {
          mt: 1.2,
          mb: 0.9,
          lineHeight: 1.15,
        },
        '& h1:first-of-type, & h2:first-of-type, & h3:first-of-type, & h4:first-of-type': {
          mt: 0,
        },
        '& p': { my: 0.7, lineHeight: 1.55, fontSize: 'inherit' },
        '& ul, & ol': { my: 0.8, pl: 2.5 },
        '& li': { mb: 0.45, fontSize: 'inherit' },
        '& a': {
          color: theme.palette.primary.main,
          textDecorationColor: theme.palette.primary.main,
          textUnderlineOffset: '2px',
          fontWeight: 500,
          transition: 'color 120ms ease',
        },
        '& a:hover': {
          color: theme.palette.primary.light,
        },
        '& code': {
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
          bgcolor: 'rgba(148,163,184,0.18)',
          px: 0.5,
          py: 0.15,
          borderRadius: 1,
          fontSize: '0.88em',
        },
        '& pre': {
          bgcolor: 'rgba(15,23,42,0.6)',
          border: `1px solid ${theme.palette.divider}`,
          borderRadius: 2,
          p: 1.25,
          overflowX: 'auto',
          my: 1,
        },
        '& pre code': {
          bgcolor: 'transparent',
          p: 0,
          borderRadius: 0,
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
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </Box>
  );
}
