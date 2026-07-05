import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  ListSubheader,
  MenuItem,
  MenuList,
  Paper,
  Popper,
  Typography,
  useTheme,
} from '@mui/material';
import {
  buildReference,
  parseReferencePath,
  tokenizeTemplate,
  type TemplateToken,
} from '@shared/workflow-templates';

export interface TemplateFieldOption {
  /** Full reference path, e.g. nodes.paso1.output.total or trigger.type */
  referencePath: string;
  /** Pretty label shown in the dropdown and inside the pill. */
  label: string;
  /** Group header (node name). */
  group: string;
  sample?: unknown;
}

export interface TemplateSourceNode {
  nodeId: string;
  nodeName: string;
  fields: Array<{ path: string; sample?: unknown }>;
}

const REFERENCE_ATTRIBUTE = 'data-template-ref';

/** Builds the dropdown options offered when the person types {{. */
export const buildTemplateFieldOptions = (
  sources: TemplateSourceNode[],
  triggerGroupLabel: string,
  wholeOutputLabel: string,
): TemplateFieldOption[] => {
  const options: TemplateFieldOption[] = [];
  for (const source of sources) {
    options.push({
      referencePath: buildReference(source.nodeId),
      label: wholeOutputLabel,
      group: source.nodeName,
    });
    for (const field of source.fields) {
      options.push({
        referencePath: buildReference(source.nodeId, field.path),
        label: field.path,
        group: source.nodeName,
        sample: field.sample,
      });
    }
  }
  options.push({ referencePath: 'trigger.type', label: 'type', group: triggerGroupLabel });
  options.push({ referencePath: 'trigger.firedAt', label: 'firedAt', group: triggerGroupLabel });
  return options;
};

/** Pretty pill label for a raw reference path. */
export const pillLabelForReference = (
  referencePath: string,
  sources: TemplateSourceNode[],
  triggerGroupLabel: string,
  wholeOutputLabel: string,
): string => {
  const parts = parseReferencePath(referencePath);
  if (!parts) {
    return referencePath;
  }
  if (parts.kind === 'trigger') {
    return `${triggerGroupLabel} · ${parts.fieldPath ?? 'type'}`;
  }
  const source = sources.find((entry) => entry.nodeId === parts.nodeId);
  const nodeName = source?.nodeName ?? parts.nodeId ?? referencePath;
  return parts.fieldPath ? `${nodeName} · ${parts.fieldPath}` : `${nodeName} · ${wholeOutputLabel}`;
};

interface TemplateEditorProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  sources: TemplateSourceNode[];
  helperText?: string;
  placeholder?: string;
  minHeight?: number;
  triggerGroupLabel: string;
  wholeOutputLabel: string;
}

/**
 * Plain-text editor where {{references}} render as pills. Typing "{{" opens
 * an autocomplete of upstream node fields; the stored value is always the
 * canonical template string.
 */
export function TemplateEditor({
  label,
  value,
  onChange,
  sources,
  helperText,
  placeholder,
  minHeight = 96,
  triggerGroupLabel,
  wholeOutputLabel,
}: TemplateEditorProps) {
  const theme = useTheme();
  const editorRef = useRef<HTMLDivElement | null>(null);
  const lastEmittedRef = useRef<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuFilter, setMenuFilter] = useState('');
  const [menuIndex, setMenuIndex] = useState(0);
  const [focused, setFocused] = useState(false);

  const options = useMemo(
    () => buildTemplateFieldOptions(sources, triggerGroupLabel, wholeOutputLabel),
    [sources, triggerGroupLabel, wholeOutputLabel],
  );
  const filteredOptions = useMemo(() => {
    const query = menuFilter.trim().toLowerCase();
    const matches = query
      ? options.filter((option) =>
          option.label.toLowerCase().includes(query)
          || option.group.toLowerCase().includes(query)
          || option.referencePath.toLowerCase().includes(query))
      : options;
    return matches.slice(0, 30);
  }, [options, menuFilter]);

  const pillStyles = {
    display: 'inline-block',
    padding: '1px 8px',
    margin: '0 1px',
    borderRadius: '10px',
    backgroundColor: theme.palette.mode === 'dark'
      ? 'rgba(124, 77, 255, 0.22)'
      : 'rgba(124, 77, 255, 0.12)',
    color: theme.palette.mode === 'dark' ? '#b39dff' : '#5e35b1',
    fontSize: '0.8em',
    fontWeight: 600,
    whiteSpace: 'nowrap' as const,
    userSelect: 'none' as const,
  };

  const createPill = (referencePath: string): HTMLSpanElement => {
    const pill = document.createElement('span');
    pill.setAttribute(REFERENCE_ATTRIBUTE, referencePath);
    pill.setAttribute('contenteditable', 'false');
    pill.textContent = pillLabelForReference(referencePath, sources, triggerGroupLabel, wholeOutputLabel);
    Object.assign(pill.style, {
      display: pillStyles.display,
      padding: pillStyles.padding,
      margin: pillStyles.margin,
      borderRadius: pillStyles.borderRadius,
      backgroundColor: pillStyles.backgroundColor,
      color: pillStyles.color,
      fontSize: pillStyles.fontSize,
      fontWeight: String(pillStyles.fontWeight),
      whiteSpace: pillStyles.whiteSpace,
      userSelect: pillStyles.userSelect,
    });
    return pill;
  };

  const serialize = (): string => {
    const root = editorRef.current;
    if (!root) {
      return value;
    }
    let result = '';
    const walk = (node: Node): void => {
      if (node.nodeType === Node.TEXT_NODE) {
        result += node.textContent ?? '';
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) {
        return;
      }
      const element = node as HTMLElement;
      const reference = element.getAttribute?.(REFERENCE_ATTRIBUTE);
      if (reference) {
        result += `{{${reference}}}`;
        return;
      }
      if (element.tagName === 'BR') {
        result += '\n';
        return;
      }
      const isBlock = element.tagName === 'DIV' || element.tagName === 'P';
      if (isBlock && result.length > 0 && !result.endsWith('\n')) {
        result += '\n';
      }
      element.childNodes.forEach(walk);
    };
    root.childNodes.forEach(walk);
    return result;
  };

  const renderValue = (nextValue: string): void => {
    const root = editorRef.current;
    if (!root) {
      return;
    }
    root.innerHTML = '';
    const tokens: TemplateToken[] = tokenizeTemplate(nextValue);
    for (const token of tokens) {
      if (token.type === 'reference') {
        root.appendChild(createPill(token.path));
        continue;
      }
      const lines = token.value.split('\n');
      lines.forEach((line, index) => {
        if (index > 0) {
          root.appendChild(document.createElement('br'));
        }
        if (line) {
          root.appendChild(document.createTextNode(line));
        }
      });
    }
  };

  useEffect(() => {
    if (value !== lastEmittedRef.current) {
      renderValue(value);
      lastEmittedRef.current = value;
    }
  }, [value, sources]);

  const emitChange = (): void => {
    const serialized = serialize();
    lastEmittedRef.current = serialized;
    onChange(serialized);
  };

  /** Text right before the caret inside the current text node. */
  const textBeforeCaret = (): { node: Text; text: string } | null => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) {
      return null;
    }
    const range = selection.getRangeAt(0);
    if (range.startContainer.nodeType !== Node.TEXT_NODE) {
      return null;
    }
    const node = range.startContainer as Text;
    if (!editorRef.current?.contains(node)) {
      return null;
    }
    return { node, text: (node.textContent ?? '').slice(0, range.startOffset) };
  };

  const updateMenuFromCaret = (): void => {
    const before = textBeforeCaret();
    const match = before ? /\{\{([a-zA-Z0-9_. -]*)$/.exec(before.text) : null;
    if (match) {
      setMenuFilter(match[1] ?? '');
      setMenuIndex(0);
      setMenuOpen(true);
    } else {
      setMenuOpen(false);
    }
  };

  const insertOption = (option: TemplateFieldOption): void => {
    const before = textBeforeCaret();
    if (before) {
      const match = /\{\{([a-zA-Z0-9_. -]*)$/.exec(before.text);
      if (match) {
        const start = before.text.length - (match[0]?.length ?? 0);
        const selection = window.getSelection();
        const range = document.createRange();
        range.setStart(before.node, start);
        range.setEnd(before.node, before.text.length);
        range.deleteContents();
        const pill = createPill(option.referencePath);
        range.insertNode(pill);
        const spacer = document.createTextNode(' ');
        pill.after(spacer);
        range.setStartAfter(spacer);
        range.collapse(true);
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    }
    setMenuOpen(false);
    emitChange();
  };

  return (
    <Box>
      <Typography variant="caption" color={focused ? 'primary' : 'text.secondary'} sx={{ display: 'block', mb: 0.5 }}>
        {label}
      </Typography>
      <Box
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={label}
        sx={{
          minHeight,
          maxHeight: 320,
          overflow: 'auto',
          border: 1,
          borderColor: focused ? 'primary.main' : 'divider',
          borderWidth: focused ? 2 : 1,
          borderRadius: 1,
          px: 1.5,
          py: 1,
          fontSize: '0.875rem',
          lineHeight: 1.6,
          outline: 'none',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          '&:empty::before': {
            content: `"${(placeholder ?? '').replace(/"/g, '\\"')}"`,
            color: 'text.disabled',
          },
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          window.setTimeout(() => setMenuOpen(false), 150);
        }}
        onInput={() => {
          emitChange();
          updateMenuFromCaret();
        }}
        onKeyUp={(event) => {
          if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
            updateMenuFromCaret();
          }
        }}
        onKeyDown={(event) => {
          if (!menuOpen) {
            return;
          }
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setMenuIndex((current) => Math.min(current + 1, filteredOptions.length - 1));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setMenuIndex((current) => Math.max(current - 1, 0));
          } else if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault();
            const option = filteredOptions[menuIndex] ?? filteredOptions[0];
            if (option) {
              insertOption(option);
            }
          } else if (event.key === 'Escape') {
            event.preventDefault();
            setMenuOpen(false);
          }
        }}
        onPaste={(event) => {
          event.preventDefault();
          const text = event.clipboardData.getData('text/plain');
          document.execCommand('insertText', false, text);
        }}
      />
      {helperText ? (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
          {helperText}
        </Typography>
      ) : null}
      <Popper
        open={menuOpen && filteredOptions.length > 0}
        anchorEl={editorRef.current}
        placement="bottom-start"
        sx={{ zIndex: (muiTheme) => muiTheme.zIndex.modal + 1 }}
      >
        <Paper elevation={4} sx={{ maxHeight: 280, overflow: 'auto', minWidth: 280 }}>
          <MenuList dense>
            {filteredOptions.map((option, index) => {
              const previousGroup = filteredOptions[index - 1]?.group;
              return [
                option.group !== previousGroup ? (
                  <ListSubheader key={`${option.group}-header`} sx={{ lineHeight: '28px', bgcolor: 'transparent' }}>
                    {option.group}
                  </ListSubheader>
                ) : null,
                <MenuItem
                  key={option.referencePath}
                  selected={index === menuIndex}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    insertOption(option);
                  }}
                >
                  <Box sx={{ overflow: 'hidden' }}>
                    <Typography variant="body2" noWrap>{option.label}</Typography>
                    {option.sample !== undefined ? (
                      <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block', maxWidth: 320 }}>
                        {typeof option.sample === 'string' ? option.sample : JSON.stringify(option.sample)}
                      </Typography>
                    ) : null}
                  </Box>
                </MenuItem>,
              ];
            })}
          </MenuList>
        </Paper>
      </Popper>
    </Box>
  );
}
