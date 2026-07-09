import SearchRounded from '@mui/icons-material/SearchRounded';
import {
  alpha,
  Box,
  Collapse,
  Divider,
  List,
  ListItemButton,
  ListItemText,
  Paper,
  Stack,
  TextField,
  Typography,
  useTheme,
} from '@mui/material';
import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ExternalMarkdownLink } from '@renderer/components/ExternalMarkdownLink';
import { forgerDocsBundle, type ForgerDocEntry, type ForgerDocsLanguage } from '@renderer/docs/forger-docs.generated';
import type { Locale } from '@renderer/i18n';

interface DocsViewProps {
  locale: Locale;
  onOpenExternalUrl: (url: string) => void;
}

const slugifyHeading = (value: string) =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section';

export function DocsView({ locale, onOpenExternalUrl }: DocsViewProps) {
  const theme = useTheme();
  const lang: ForgerDocsLanguage = locale === 'es' ? 'es' : 'en';
  const docs = forgerDocsBundle.docs[lang] as readonly ForgerDocEntry[];
  const [selectedSlug, setSelectedSlug] = useState<string>(docs[0]?.slug ?? '');
  const [query, setQuery] = useState('');
  const [expandedSlugs, setExpandedSlugs] = useState<Set<string>>(() => new Set([docs[0]?.slug ?? '']));
  const [pendingHeadingId, setPendingHeadingId] = useState<string | null>(null);
  const selectedDoc = docs.find((doc) => doc.slug === selectedSlug) ?? docs[0];
  const normalizedQuery = query.trim().toLowerCase();
  const filteredDocs = useMemo(
    () =>
      normalizedQuery
        ? docs.filter((doc) =>
          `${doc.title} ${doc.description} ${doc.headings.map((heading) => heading.title).join(' ')} ${doc.body}`.toLowerCase().includes(normalizedQuery)
        )
        : docs,
    [docs, normalizedQuery],
  );
  const selectDoc = (slug: string, headingId?: string) => {
    setSelectedSlug(slug);
    setExpandedSlugs((current) => new Set([...current, slug]));
    setPendingHeadingId(headingId ?? null);
  };
  const toggleExpanded = (slug: string) => {
    setExpandedSlugs((current) => {
      const next = new Set(current);
      if (next.has(slug)) {
        next.delete(slug);
      } else {
        next.add(slug);
      }
      return next;
    });
  };

  useEffect(() => {
    if (!pendingHeadingId) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(pendingHeadingId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setPendingHeadingId(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pendingHeadingId, selectedDoc.slug]);

  return (
    <Stack spacing={2.5} sx={{ height: '100%', minHeight: 0 }}>
      <Stack spacing={0.5}>
        <Typography variant="h4">{forgerDocsBundle.title[lang]}</Typography>
        <Typography color="text.secondary">{forgerDocsBundle.subtitle[lang]}</Typography>
      </Stack>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: '280px minmax(0, 1fr)' },
          gap: 2,
          minHeight: 0,
          flex: 1,
        }}
      >
        <Paper variant="outlined" sx={{ minHeight: 0, overflow: 'hidden' }}>
          <Stack sx={{ height: '100%', minHeight: 0 }}>
            <Box sx={{ p: 1.5 }}>
              <TextField
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                size="small"
                fullWidth
                placeholder={lang === 'es' ? 'Buscar docs' : 'Search docs'}
                InputProps={{
                  startAdornment: <SearchRounded fontSize="small" sx={{ mr: 1, color: 'text.secondary' }} />,
                }}
              />
            </Box>
            <Divider />
            <List sx={{ overflowY: 'auto', p: 1, minHeight: 0 }}>
              {filteredDocs.map((doc) => (
                <Box key={doc.slug} sx={{ mb: 0.5 }}>
                  <ListItemButton
                    selected={doc.slug === selectedDoc.slug}
                    onClick={() => selectDoc(doc.slug)}
                    sx={{ borderRadius: 1, pr: 1 }}
                  >
                    <ListItemText
                      primary={doc.title}
                      primaryTypographyProps={{ fontWeight: 700, fontSize: '0.92rem' }}
                    />
                    <Box
                      component="button"
                      type="button"
                      aria-label={expandedSlugs.has(doc.slug) ? 'Collapse section' : 'Expand section'}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleExpanded(doc.slug);
                      }}
                      sx={{
                        border: 0,
                        bgcolor: 'transparent',
                        color: 'text.secondary',
                        cursor: 'pointer',
                        fontSize: '1rem',
                        transform: expandedSlugs.has(doc.slug) ? 'rotate(90deg)' : 'rotate(0deg)',
                        transition: 'transform 120ms ease',
                      }}
                    >
                      ›
                    </Box>
                  </ListItemButton>
                  <Collapse in={expandedSlugs.has(doc.slug)} timeout="auto" unmountOnExit>
                    <List disablePadding sx={{ pl: 1.5, borderLeft: `1px solid ${theme.palette.divider}`, ml: 1.5 }}>
                      {doc.headings.map((heading) => (
                        <ListItemButton
                          key={heading.id}
                          onClick={() => selectDoc(doc.slug, heading.id)}
                          sx={{ borderRadius: 1, py: 0.5 }}
                        >
                          <ListItemText
                            primary={heading.title}
                            primaryTypographyProps={{ color: 'text.secondary', fontSize: '0.78rem' }}
                          />
                        </ListItemButton>
                      ))}
                    </List>
                  </Collapse>
                </Box>
              ))}
            </List>
          </Stack>
        </Paper>

        <Paper variant="outlined" sx={{ minWidth: 0, minHeight: 0, overflowY: 'auto', p: { xs: 2, md: 3 } }}>
          <Stack spacing={2.5} sx={{ maxWidth: 860 }}>
            <Stack spacing={1}>
              <Typography variant="h4">{selectedDoc.title}</Typography>
              <Typography color="text.secondary">{selectedDoc.description}</Typography>
            </Stack>

            <Box
              sx={{
                '& h2': {
                  mt: 3,
                  mb: 1,
                  pt: 2,
                  borderTop: `1px solid ${theme.palette.divider}`,
                  fontSize: '1.35rem',
                },
                '& h2:first-of-type': { mt: 0, pt: 0, borderTop: 0 },
                '& p': { color: 'text.secondary', lineHeight: 1.75 },
                '& code': {
                  px: 0.5,
                  py: 0.15,
                  borderRadius: 0.5,
                  bgcolor: alpha(theme.palette.primary.main, 0.1),
                  color: 'primary.main',
                },
                '& a': { color: 'primary.main' },
              }}
            >
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  h2: ({ children }) => <h2 id={slugifyHeading(String(children))}>{children}</h2>,
                  h3: ({ children }) => <h3 id={slugifyHeading(String(children))}>{children}</h3>,
                  h4: ({ children }) => <h4 id={slugifyHeading(String(children))}>{children}</h4>,
                  a: ({ href, children }) => (
                    <ExternalMarkdownLink href={href} onOpenExternalUrl={onOpenExternalUrl}>
                      {children}
                    </ExternalMarkdownLink>
                  ),
                }}
              >
                {selectedDoc.body}
              </ReactMarkdown>
            </Box>
          </Stack>
        </Paper>
      </Box>
    </Stack>
  );
}
