import { useState, type MouseEvent } from 'react';
import {
  Box,
  Checkbox,
  FormControlLabel,
  IconButton,
  ListSubheader,
  Menu,
  MenuItem,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import DataObjectRounded from '@mui/icons-material/DataObjectRounded';
import { referenceForSource, type TemplateSourceNode } from './TemplateEditor';

interface SchemaProperty {
  type?: string;
  description?: string;
  enum?: unknown[];
  items?: unknown;
}

const asSchemaProperty = (value: unknown): SchemaProperty =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as SchemaProperty : {};

const arrayTextValue = (value: unknown): string => {
  if (Array.isArray(value)) {
    return value.map((item) => typeof item === 'string' ? item : JSON.stringify(item)).join('\n');
  }
  if (typeof value === 'string') {
    return value;
  }
  return '';
};

const parseStringArrayField = (raw: string): string[] | string | undefined => {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^\{\{\s*[a-zA-Z0-9_.-]+\s*\}\}$/.test(trimmed)) {
    return trimmed;
  }
  const items = raw
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
};

/** Small adornment button that inserts a {{reference}} into a field. */
export const MappingMenuButton = ({ sources, tooltip, wholeOutputLabel, triggerGroupLabel, onPick }: {
  sources: TemplateSourceNode[];
  tooltip: string;
  wholeOutputLabel: string;
  triggerGroupLabel: string;
  onPick: (reference: string) => void;
}) => {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const open = (event: MouseEvent<HTMLElement>) => setAnchorEl(event.currentTarget);
  const close = () => setAnchorEl(null);
  const pick = (reference: string) => {
    onPick(`{{${reference}}}`);
    close();
  };
  return (
    <>
      <Tooltip title={tooltip}>
        <IconButton size="small" onClick={open} edge="end">
          <DataObjectRounded fontSize="small" />
        </IconButton>
      </Tooltip>
      <Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={close}>
        {sources.flatMap((source) => [
          <ListSubheader key={`${source.nodeId}-header`} sx={{ lineHeight: '28px', bgcolor: 'background.paper' }}>
            {source.nodeName}
          </ListSubheader>,
          <MenuItem key={`${source.nodeId}-whole`} dense onClick={() => pick(referenceForSource(source))}>
            {wholeOutputLabel}
          </MenuItem>,
          ...source.fields.map((field) => (
            <MenuItem key={`${source.nodeId}-${field.path}`} dense onClick={() => pick(referenceForSource(source, field.path))}>
              <Box sx={{ overflow: 'hidden' }}>
                <Typography variant="body2" noWrap>{field.path}</Typography>
                {field.sample !== undefined ? (
                  <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block', maxWidth: 280 }}>
                    {typeof field.sample === 'string' ? field.sample : JSON.stringify(field.sample)}
                  </Typography>
                ) : null}
              </Box>
            </MenuItem>
          )),
        ])}
        <ListSubheader sx={{ lineHeight: '28px', bgcolor: 'background.paper' }}>{triggerGroupLabel}</ListSubheader>
        <MenuItem dense onClick={() => pick('trigger.type')}>type</MenuItem>
        <MenuItem dense onClick={() => pick('trigger.firedAt')}>firedAt</MenuItem>
      </Menu>
    </>
  );
};

interface SchemaFormProps {
  schema: Record<string, unknown>;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  sources: TemplateSourceNode[];
  mapTooltip: string;
  wholeOutputLabel: string;
  triggerGroupLabel: string;
}

/**
 * Renders a form from a JSON-schema-like action input schema. String and
 * number fields accept fixed values or {{references}} to previous nodes.
 */
export function SchemaForm({ schema, value, onChange, sources, mapTooltip, wholeOutputLabel, triggerGroupLabel }: SchemaFormProps) {
  const properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
    ? schema.properties as Record<string, unknown>
    : {};
  const required = new Set(Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === 'string')
    : []);

  const setField = (key: string, fieldValue: unknown) => {
    const next = { ...value };
    if (fieldValue === undefined || fieldValue === '') {
      delete next[key];
    } else {
      next[key] = fieldValue;
    }
    onChange(next);
  };

  return (
    <>
      {Object.entries(properties).map(([key, rawProperty]) => {
        const property = asSchemaProperty(rawProperty);
        const label = required.has(key) ? `${key} *` : key;
        const current = value[key];

        if (Array.isArray(property.enum) && property.enum.length > 0) {
          return (
            <TextField
              key={key}
              select
              size="small"
              label={label}
              helperText={property.description}
              value={typeof current === 'string' ? current : ''}
              onChange={(event) => setField(key, event.target.value)}
            >
              {property.enum.map((option) => (
                <MenuItem key={String(option)} value={String(option)}>{String(option)}</MenuItem>
              ))}
            </TextField>
          );
        }

        if (property.type === 'boolean') {
          return (
            <FormControlLabel
              key={key}
              control={(
                <Checkbox
                  size="small"
                  checked={current === true}
                  onChange={(event) => setField(key, event.target.checked ? true : undefined)}
                />
              )}
              label={label}
            />
          );
        }

        const itemSchema = asSchemaProperty(property.items);
        if (property.type === 'array' && itemSchema.type === 'string') {
          const displayValue = arrayTextValue(current);
          return (
            <TextField
              key={key}
              size="small"
              label={label}
              helperText={property.description}
              value={displayValue}
              multiline
              minRows={2}
              onChange={(event) => setField(key, parseStringArrayField(event.target.value))}
              slotProps={{
                input: {
                  endAdornment: sources.length > 0 ? (
                    <MappingMenuButton
                      sources={sources}
                      tooltip={mapTooltip}
                      wholeOutputLabel={wholeOutputLabel}
                      triggerGroupLabel={triggerGroupLabel}
                      onPick={(reference) => setField(key, displayValue ? parseStringArrayField(`${displayValue}\n${reference}`) : reference)}
                    />
                  ) : undefined,
                },
              }}
            />
          );
        }

        // Numbers still accept {{references}}, so the field stays text-based
        // and only converts to a number when the content is numeric.
        const isTemplated = typeof current === 'string' && current.includes('{{');
        const displayValue = current === undefined || current === null
          ? ''
          : typeof current === 'object' ? JSON.stringify(current) : String(current);
        return (
          <TextField
            key={key}
            size="small"
            label={label}
            helperText={property.description}
            value={displayValue}
            multiline={property.type === 'string' && (key === 'text' || key === 'description' || key === 'body')}
            onChange={(event) => {
              const raw = event.target.value;
              if (property.type === 'number' && raw.trim() !== '' && !raw.includes('{{') && Number.isFinite(Number(raw))) {
                setField(key, Number(raw));
              } else {
                setField(key, raw);
              }
            }}
            slotProps={{
              input: {
                endAdornment: sources.length > 0 ? (
                  <MappingMenuButton
                    sources={sources}
                    tooltip={mapTooltip}
                    wholeOutputLabel={wholeOutputLabel}
                    triggerGroupLabel={triggerGroupLabel}
                    onPick={(reference) => setField(key, isTemplated || displayValue ? `${displayValue}${reference}` : reference)}
                  />
                ) : undefined,
              },
            }}
          />
        );
      })}
    </>
  );
}
