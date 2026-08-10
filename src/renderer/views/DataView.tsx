import { useEffect, useState } from 'react';
import StorageRounded from '@mui/icons-material/StorageRounded';
import {
  Box,
  CircularProgress,
  Stack,
  Typography,
  useTheme,
} from '@mui/material';
import type { DbListTablesResponse, DbQueryTableResponse } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';

interface DataViewProps {
  t: AppDictionary;
  selectedAppId: string | null;
  onDbListTables: (appId: string) => Promise<DbListTablesResponse>;
  onDbQueryTable: (appId: string, tableName: string, limit?: number) => Promise<DbQueryTableResponse>;
}

const ROW_LIMIT = 1000;

export function DataView({
  t,
  selectedAppId,
  onDbListTables,
  onDbQueryTable,
}: DataViewProps) {
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';

  const [tables, setTables] = useState<string[]>([]);
  const [selectedTable, setSelectedTable] = useState<string>('');
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<unknown[][]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [isLoadingTables, setIsLoadingTables] = useState(false);
  const [isLoadingRows, setIsLoadingRows] = useState(false);
  const [tablesError, setTablesError] = useState<string | null>(null);
  const [rowsError, setRowsError] = useState<string | null>(null);

  // Load tables whenever selected app changes
  useEffect(() => {
    if (!selectedAppId) {
      setTables([]);
      setSelectedTable('');
      setColumns([]);
      setRows([]);
      setTablesError(null);
      return;
    }

    const load = async () => {
      setIsLoadingTables(true);
      setTablesError(null);
      setTables([]);
      setSelectedTable('');
      setColumns([]);
      setRows([]);

      const result = await onDbListTables(selectedAppId);
      setIsLoadingTables(false);

      if (!('tables' in result) || result.tables === undefined) {
        const errorKey = (result as { error: string }).error;
        if (errorKey === 'db_module_unavailable') {
          setTablesError(t.sections.datos.dbModuleUnavailable);
        } else if (errorKey === 'db_file_not_found') {
          setTablesError(t.sections.datos.dbNotFound);
        } else {
          setTablesError(`${t.sections.datos.errorLoadingTables}: ${errorKey}`);
        }
        return;
      }

      setTables(result.tables);
      if (result.tables.length > 0) {
        setSelectedTable(result.tables[0]);
      }
    };

    void load();
  }, [selectedAppId, onDbListTables, t]);

  // Load rows whenever selected table changes
  useEffect(() => {
    if (!selectedAppId || !selectedTable) {
      setColumns([]);
      setRows([]);
      setTotalRows(0);
      setRowsError(null);
      return;
    }

    const load = async () => {
      setIsLoadingRows(true);
      setRowsError(null);
      setColumns([]);
      setRows([]);

      const result = await onDbQueryTable(selectedAppId, selectedTable, ROW_LIMIT);
      setIsLoadingRows(false);

      if (!('columns' in result) || result.columns === undefined) {
        const errorKey = (result as { error: string }).error;
        setRowsError(`${t.sections.datos.errorLoadingRows}: ${errorKey}`);
        return;
      }

      setColumns(result.columns);
      setRows(result.rows);
      setTotalRows(result.total);
    };

    void load();
  }, [selectedAppId, selectedTable, onDbQueryTable, t]);

  // Colors
  const headerBg = isDark ? theme.palette.background.paper : '#F1F3F7';
  const cellBorder = `1px solid ${theme.palette.divider}`;

  const renderTableArea = () => {
    if (!selectedAppId) {
      return (
        <Stack alignItems="center" justifyContent="center" sx={{ flex: 1 }} spacing={1}>
          <StorageRounded sx={{ fontSize: 36, color: 'text.disabled' }} />
          <Typography variant="body2" color="text.secondary">{t.sections.datos.inactiveApp}</Typography>
        </Stack>
      );
    }

    if (isLoadingTables) {
      return (
        <Stack alignItems="center" justifyContent="center" sx={{ flex: 1 }} spacing={1.5}>
          <CircularProgress size={28} />
          <Typography variant="body2" color="text.secondary">{t.sections.datos.loadingTables}</Typography>
        </Stack>
      );
    }

    if (tablesError) {
      return (
        <Stack alignItems="center" justifyContent="center" sx={{ flex: 1, px: 4 }} spacing={1}>
          <StorageRounded sx={{ fontSize: 36, color: 'text.disabled' }} />
          <Typography variant="body2" color="text.secondary" textAlign="center">{tablesError}</Typography>
        </Stack>
      );
    }

    if (tables.length === 0) {
      return (
        <Stack alignItems="center" justifyContent="center" sx={{ flex: 1 }} spacing={1}>
          <StorageRounded sx={{ fontSize: 36, color: 'text.disabled' }} />
          <Typography variant="body2" color="text.secondary">{t.sections.datos.noTablesFound}</Typography>
        </Stack>
      );
    }

    if (isLoadingRows) {
      return (
        <Stack alignItems="center" justifyContent="center" sx={{ flex: 1 }} spacing={1.5}>
          <CircularProgress size={28} />
          <Typography variant="body2" color="text.secondary">{t.sections.datos.loadingRows}</Typography>
        </Stack>
      );
    }

    if (rowsError) {
      return (
        <Stack alignItems="center" justifyContent="center" sx={{ flex: 1, px: 4 }} spacing={1}>
          <StorageRounded sx={{ fontSize: 36, color: 'text.disabled' }} />
          <Typography variant="body2" color="text.secondary" textAlign="center">{rowsError}</Typography>
        </Stack>
      );
    }

    return (
      <Box sx={{ flex: 1, minHeight: 0, overflowX: 'auto', overflowY: 'auto' }}>
        <table
          style={{
            borderCollapse: 'collapse',
            width: 'max-content',
            minWidth: '100%',
            tableLayout: 'auto',
            fontSize: '13px',
            fontFamily: '"IBM Plex Sans", "Segoe UI", sans-serif',
          }}
        >
          <thead>
            <tr>
              <th
                style={{
                  position: 'sticky',
                  top: 0,
                  left: 0,
                  zIndex: 3,
                  background: headerBg,
                  borderRight: cellBorder,
                  borderBottom: cellBorder,
                  padding: '7px 10px',
                  textAlign: 'center',
                  color: theme.palette.text.secondary,
                  fontWeight: 600,
                  fontSize: '11px',
                  minWidth: 48,
                  userSelect: 'none',
                }}
              >
                #
              </th>
              {columns.map((col) => (
                <th
                  key={col}
                  style={{
                    position: 'sticky',
                    top: 0,
                    zIndex: 2,
                    background: headerBg,
                    borderRight: cellBorder,
                    borderBottom: cellBorder,
                    padding: '7px 14px',
                    textAlign: 'left',
                    fontWeight: 600,
                    color: theme.palette.text.primary,
                    whiteSpace: 'nowrap',
                    userSelect: 'none',
                  }}
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIdx) => (
              <tr
                key={rowIdx}
                style={{
                  background: rowIdx % 2 === 0
                    ? 'transparent'
                    : (isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.015)'),
                }}
              >
                <td
                  style={{
                    position: 'sticky',
                    left: 0,
                    zIndex: 1,
                    background: headerBg,
                    borderRight: cellBorder,
                    borderBottom: cellBorder,
                    padding: '5px 10px',
                    textAlign: 'center',
                    color: theme.palette.text.secondary,
                    fontSize: '11px',
                    userSelect: 'none',
                  }}
                >
                  {rowIdx + 1}
                </td>
                {row.map((cell, cellIdx) => (
                  <td
                    key={cellIdx}
                    style={{
                      borderRight: cellBorder,
                      borderBottom: cellBorder,
                      padding: '5px 14px',
                      color: theme.palette.text.primary,
                      whiteSpace: 'nowrap',
                      maxWidth: 320,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {cell === null || cell === undefined
                      ? <span style={{ color: theme.palette.text.disabled, fontStyle: 'italic' }}>null</span>
                      : typeof cell === 'boolean'
                        ? String(cell)
                        : (cell as string | number).toString()}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Box>
    );
  };

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Header */}
      <Stack spacing={0.5} sx={{ mb: 2, flexShrink: 0 }}>
        <Typography variant="h4">{t.sections.datos.title}</Typography>
        <Typography color="text.secondary">{t.sections.datos.subtitle}</Typography>
        {rows.length > 0 && !isLoadingRows && (
          <Typography variant="caption" color="text.disabled">
            {t.sections.datos.rowCount(rows.length, totalRows)}
          </Typography>
        )}
      </Stack>

      {/* Main grid area */}
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          border: `1px solid ${theme.palette.divider}`,
          borderRadius: 1.5,
          overflow: 'hidden',
          bgcolor: 'background.paper',
        }}
      >
        {renderTableArea()}

        {/* Bottom sheet tabs */}
        {tables.length > 0 && (
          <Box
            sx={{
              flexShrink: 0,
              borderTop: `1px solid ${theme.palette.divider}`,
              bgcolor: isDark ? 'rgba(0,0,0,0.2)' : '#EAECF0',
              px: 1,
              py: 0.5,
              display: 'flex',
              flexDirection: 'row',
              gap: 0.5,
              overflowX: 'auto',
              '&::-webkit-scrollbar': { height: 4 },
              '&::-webkit-scrollbar-thumb': { borderRadius: 2, bgcolor: theme.palette.divider },
            }}
          >
            {tables.map((table) => {
              const active = table === selectedTable;
              return (
                <Box
                  key={table}
                  component="button"
                  onClick={() => setSelectedTable(table)}
                  sx={{
                    flexShrink: 0,
                    cursor: 'pointer',
                    border: 'none',
                    outline: 'none',
                    px: 1.5,
                    py: 0.75,
                    borderRadius: '6px 6px 0 0',
                    fontSize: '12px',
                    fontFamily: '"IBM Plex Sans", "Segoe UI", sans-serif',
                    fontWeight: active ? 600 : 400,
                    bgcolor: active ? theme.palette.background.paper : 'transparent',
                    color: active ? theme.palette.text.primary : theme.palette.text.secondary,
                    borderTop: active ? `2px solid ${theme.palette.primary.main}` : '2px solid transparent',
                    transition: 'background 0.12s, color 0.12s',
                    '&:hover': {
                      bgcolor: active ? theme.palette.background.paper : 'rgba(0,0,0,0.04)',
                      color: theme.palette.text.primary,
                    },
                  }}
                >
                  {table}
                </Box>
              );
            })}
          </Box>
        )}
      </Box>
    </Box>
  );
}
