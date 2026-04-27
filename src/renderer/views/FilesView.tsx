import AddRounded from '@mui/icons-material/AddRounded';
import CategoryRounded from '@mui/icons-material/CategoryRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import DriveFileMoveRounded from '@mui/icons-material/DriveFileMoveRounded';
import EditRounded from '@mui/icons-material/EditRounded';
import {
  Box,
  Button,
  IconButton,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material';
import type { AppDictionary } from '@renderer/i18n';
import type { FilesListInput, ForgerFileCategory, ForgerFileRecord } from '@shared/types';

interface FilesViewProps {
  t: AppDictionary;
  files: ForgerFileRecord[];
  categories: ForgerFileCategory[];
  filters: FilesListInput;
  onFiltersChange: (filters: FilesListInput) => void;
  onCreateCategory: () => void;
  onRenameCategory: (categoryPath: string) => void;
  onDeleteCategory: (categoryPath: string) => void;
  onRenameFile: (file: ForgerFileRecord) => void;
  onMoveFile: (file: ForgerFileRecord) => void;
  onDeleteFile: (file: ForgerFileRecord) => void;
}

const formatBytes = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
};

const formatDate = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
};

export function FilesView({
  t,
  files,
  categories,
  filters,
  onFiltersChange,
  onCreateCategory,
  onRenameCategory,
  onDeleteCategory,
  onRenameFile,
  onMoveFile,
  onDeleteFile,
}: FilesViewProps) {
  const theme = useTheme();
  const types = Array.from(new Set(files.map((file) => file.type))).sort();

  return (
    <Stack spacing={2.25} sx={{ height: '100%', minHeight: 0 }}>
      <Box>
        <Typography variant="h4">{t.sections.files.title}</Typography>
        <Typography color="text.secondary">{t.sections.files.subtitle}</Typography>
      </Box>

      <Stack direction="row" spacing={1.25} alignItems="center" flexWrap="wrap">
        <TextField
          size="small"
          label={t.sections.files.search}
          value={filters.query ?? ''}
          onChange={(event) => onFiltersChange({ ...filters, query: event.target.value })}
          sx={{ minWidth: 260 }}
        />
        <Select
          size="small"
          displayEmpty
          value={filters.categoryPath ?? ''}
          onChange={(event) => onFiltersChange({ ...filters, categoryPath: event.target.value })}
          sx={{ minWidth: 200 }}
        >
          <MenuItem value="">{t.sections.files.allCategories}</MenuItem>
          <MenuItem value="__root">{t.sections.files.root}</MenuItem>
          {categories.map((category) => (
            <MenuItem key={category.path} value={category.path}>{category.name}</MenuItem>
          ))}
        </Select>
        <Select
          size="small"
          displayEmpty
          value={filters.type ?? ''}
          onChange={(event) => onFiltersChange({ ...filters, type: event.target.value })}
          sx={{ minWidth: 160 }}
        >
          <MenuItem value="">{t.sections.files.allTypes}</MenuItem>
          {types.map((type) => (
            <MenuItem key={type} value={type}>{type}</MenuItem>
          ))}
        </Select>
        <Button startIcon={<AddRounded />} variant="outlined" onClick={() => onCreateCategory()}>
          {t.sections.files.createCategory}
        </Button>
      </Stack>

      <Stack direction="row" spacing={1} flexWrap="wrap">
        {categories.map((category) => (
          <Stack
            key={category.path}
            direction="row"
            spacing={0.5}
            alignItems="center"
            sx={{
              border: `1px solid ${theme.palette.divider}`,
              borderRadius: 1,
              px: 1,
              py: 0.5,
            }}
          >
            <CategoryRounded fontSize="small" color="action" />
            <Typography variant="caption">{category.name}</Typography>
            <Tooltip title={t.sections.files.rename}>
              <IconButton size="small" onClick={() => onRenameCategory(category.path)}>
                <EditRounded fontSize="inherit" />
              </IconButton>
            </Tooltip>
            <Tooltip title={t.sections.files.delete}>
              <IconButton size="small" onClick={() => onDeleteCategory(category.path)}>
                <DeleteOutlineRounded fontSize="inherit" />
              </IconButton>
            </Tooltip>
          </Stack>
        ))}
      </Stack>

      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', border: `1px solid ${theme.palette.divider}`, borderRadius: 1 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: theme.palette.background.paper }}>
              {[t.sections.files.file, t.sections.files.category, t.sections.files.size, t.sections.files.uploadedAt, t.sections.files.modifiedAt, t.sections.files.actions].map((label) => (
                <th key={label} style={{ textAlign: 'left', padding: '10px 12px', borderBottom: `1px solid ${theme.palette.divider}`, whiteSpace: 'nowrap' }}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {files.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ padding: 28, textAlign: 'center', color: theme.palette.text.secondary }}>
                  {t.sections.files.noFiles}
                </td>
              </tr>
            ) : (
              files.map((file) => (
                <tr key={file.id}>
                  <td style={{ padding: '9px 12px', borderBottom: `1px solid ${theme.palette.divider}` }}>
                    <Typography variant="body2">{file.name}</Typography>
                    <Typography variant="caption" color="text.secondary">{file.type}</Typography>
                  </td>
                  <td style={{ padding: '9px 12px', borderBottom: `1px solid ${theme.palette.divider}` }}>
                    {categories.find((category) => category.path === file.categoryPath)?.name ?? (file.categoryPath || t.sections.files.root)}
                  </td>
                  <td style={{ padding: '9px 12px', borderBottom: `1px solid ${theme.palette.divider}` }}>{formatBytes(file.sizeBytes)}</td>
                  <td style={{ padding: '9px 12px', borderBottom: `1px solid ${theme.palette.divider}` }}>{formatDate(file.uploadedAt)}</td>
                  <td style={{ padding: '9px 12px', borderBottom: `1px solid ${theme.palette.divider}` }}>{formatDate(file.modifiedAt)}</td>
                  <td style={{ padding: '9px 12px', borderBottom: `1px solid ${theme.palette.divider}`, whiteSpace: 'nowrap' }}>
                    <Tooltip title={t.sections.files.rename}>
                      <IconButton size="small" onClick={() => onRenameFile(file)}>
                        <EditRounded fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title={t.sections.files.move}>
                      <IconButton size="small" onClick={() => onMoveFile(file)}>
                        <DriveFileMoveRounded fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title={t.sections.files.delete}>
                      <IconButton size="small" onClick={() => onDeleteFile(file)}>
                        <DeleteOutlineRounded fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Box>
    </Stack>
  );
}
