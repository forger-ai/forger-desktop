import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTheme, ThemeProvider } from '@mui/material';
import { describe, expect, it, vi } from 'vitest';
import type { DbListTablesResponse, DbQueryTableResponse } from '@shared/types';
import { getDictionary } from '@renderer/i18n';
import { DataView } from '@renderer/views/DataView';

const t = getDictionary('en');

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

interface RenderDataOptions {
  dark?: boolean;
  onDbListTables?: (appId: string) => Promise<DbListTablesResponse>;
  onDbQueryTable?: (appId: string, table: string, limit?: number) => Promise<DbQueryTableResponse>;
  selectedAppId?: string | null;
}

const renderData = ({
  dark = false,
  onDbListTables = vi.fn().mockResolvedValue({ tables: [], dbPath: '/data/app.db' }),
  onDbQueryTable = vi.fn().mockResolvedValue({ columns: [], rows: [], total: 0 }),
  selectedAppId = 'app-1',
}: RenderDataOptions = {}) => {
  const theme = createTheme({ palette: { mode: dark ? 'dark' : 'light' } });
  const view = render(
    <ThemeProvider theme={theme}>
      <DataView
        t={t}
        selectedAppId={selectedAppId}
        onDbListTables={onDbListTables}
        onDbQueryTable={onDbQueryTable}
      />
    </ThemeProvider>,
  );
  return { ...view, onDbListTables, onDbQueryTable, theme };
};

describe('DataView', () => {
  it('asks for an app without querying the database', () => {
    const onDbListTables = vi.fn();
    const onDbQueryTable = vi.fn();
    renderData({ selectedAppId: null, onDbListTables, onDbQueryTable });

    expect(screen.getByText(t.sections.datos.inactiveApp)).toBeVisible();
    expect(onDbListTables).not.toHaveBeenCalled();
    expect(onDbQueryTable).not.toHaveBeenCalled();
  });

  it('shows table loading followed by the empty database state', async () => {
    const request = deferred<DbListTablesResponse>();
    const onDbListTables = vi.fn().mockReturnValue(request.promise);
    renderData({ onDbListTables });

    expect(await screen.findByText(t.sections.datos.loadingTables)).toBeVisible();
    await act(async () => request.resolve({ tables: [], dbPath: '/data/app.db' }));
    expect(await screen.findByText(t.sections.datos.noTablesFound)).toBeVisible();
    expect(onDbListTables).toHaveBeenCalledWith('app-1');
  });

  it.each([
    ['db_module_unavailable', t.sections.datos.dbModuleUnavailable],
    ['db_file_not_found', t.sections.datos.dbNotFound],
    ['permission_denied', `${t.sections.datos.errorLoadingTables}: permission_denied`],
  ])('translates the %s table-list failure', async (error, message) => {
    renderData({ onDbListTables: vi.fn().mockResolvedValue({ error }) });
    expect(await screen.findByText(message)).toBeVisible();
  });

  it('loads rows, renders every cell kind, reports totals, and switches sheets', async () => {
    const user = userEvent.setup();
    const firstRows = deferred<DbQueryTableResponse>();
    const onDbQueryTable = vi.fn()
      .mockReturnValueOnce(firstRows.promise)
      .mockResolvedValueOnce({ columns: ['event'], rows: [['signed-in']], total: 1 });
    renderData({
      dark: true,
      onDbListTables: vi.fn().mockResolvedValue({ tables: ['users', 'audit'], dbPath: '/data/app.db' }),
      onDbQueryTable,
    });

    expect(await screen.findByText(t.sections.datos.loadingRows)).toBeVisible();
    await act(async () => firstRows.resolve({
      columns: ['name', 'enabled', 'optional', 'score'],
      rows: [
        ['Ada', true, null, 10],
        ['Grace', false, undefined, 20],
      ],
      total: 12,
    }));

    expect(await screen.findByRole('columnheader', { name: 'name' })).toBeVisible();
    expect(screen.getByText('Ada')).toBeVisible();
    expect(screen.getByText('Grace')).toBeVisible();
    expect(screen.getAllByText('null')).toHaveLength(2);
    expect(screen.getByText(t.sections.datos.rowCount(2, 12))).toBeVisible();
    expect(onDbQueryTable).toHaveBeenNthCalledWith(1, 'app-1', 'users', 1000);

    await user.click(screen.getByRole('button', { name: 'audit' }));
    expect(await screen.findByText('signed-in')).toBeVisible();
    expect(onDbQueryTable).toHaveBeenNthCalledWith(2, 'app-1', 'audit', 1000);
    expect(screen.getByText(t.sections.datos.rowCount(1, 1))).toBeVisible();
  });

  it('shows a table-specific failure after the row-loading state', async () => {
    const rows = deferred<DbQueryTableResponse>();
    renderData({
      onDbListTables: vi.fn().mockResolvedValue({ tables: ['users'], dbPath: '/data/app.db' }),
      onDbQueryTable: vi.fn().mockReturnValue(rows.promise),
    });

    expect(await screen.findByText(t.sections.datos.loadingRows)).toBeVisible();
    await act(async () => rows.resolve({ error: 'query_failed' }));
    expect(await screen.findByText(`${t.sections.datos.errorLoadingRows}: query_failed`)).toBeVisible();
  });

  it('clears loaded data when the selected app is removed', async () => {
    const onDbListTables = vi.fn().mockResolvedValue({ tables: ['users'], dbPath: '/data/app.db' });
    const onDbQueryTable = vi.fn().mockResolvedValue({ columns: ['name'], rows: [['Ada'], ['Grace']], total: 2 });
    const view = renderData({ onDbListTables, onDbQueryTable });
    expect(await screen.findByText('Ada')).toBeVisible();

    view.rerender(
      <ThemeProvider theme={view.theme}>
        <DataView
          t={t}
          selectedAppId={null}
          onDbListTables={onDbListTables}
          onDbQueryTable={onDbQueryTable}
        />
      </ThemeProvider>,
    );

    await waitFor(() => expect(screen.getByText(t.sections.datos.inactiveApp)).toBeVisible());
    expect(screen.queryByText('Ada')).not.toBeInTheDocument();
  });
});
