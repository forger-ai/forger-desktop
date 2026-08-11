import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FilesView } from '@renderer/views/FilesView';
import { en } from '@renderer/i18n/en';
import type { AppDictionary } from '@renderer/i18n';
import type { FilesListInput, ForgerFileCategory, ForgerFileRecord } from '@shared/types';

const t = en as unknown as AppDictionary;
const categories: ForgerFileCategory[] = [
  { path: 'invoices', name: 'Invoices', parentPath: '' },
  { path: 'notes', name: 'Notes', parentPath: '' },
];
const file = (id: string, overrides: Partial<ForgerFileRecord> = {}): ForgerFileRecord => ({
  id,
  name: `${id}.txt`,
  relativePath: `${id}.txt`,
  categoryPath: '',
  sizeBytes: 10,
  uploadedAt: '2026-08-10T10:00:00.000Z',
  modifiedAt: '2026-08-10T11:00:00.000Z',
  type: 'text/plain',
  ...overrides,
});
const files: ForgerFileRecord[] = [
  file('invalid-size', { sizeBytes: Number.NaN, uploadedAt: 'invalid-date' }),
  file('zero-size', { sizeBytes: 0, modifiedAt: 'invalid-date' }),
  file('bytes', { sizeBytes: 512, categoryPath: 'invoices' }),
  file('kilobytes', { sizeBytes: 2_048, categoryPath: 'unknown', type: 'application/pdf' }),
  file('megabytes', { sizeBytes: 2 * 1_024 * 1_024 }),
  file('gigabytes', { sizeBytes: 2 * 1_024 * 1_024 * 1_024 }),
];

const renderFiles = ({ records = files, filters = {} as FilesListInput } = {}) => {
  const handlers = {
    onFiltersChange: vi.fn(),
    onCreateCategory: vi.fn(),
    onRenameCategory: vi.fn(),
    onDeleteCategory: vi.fn(),
    onRenameFile: vi.fn(),
    onMoveFile: vi.fn(),
    onDeleteFile: vi.fn(),
  };
  const view = render(
    <FilesView
      t={t}
      files={records}
      categories={categories}
      filters={filters}
      {...handlers}
    />,
  );
  return { ...view, ...handlers };
};

describe('FilesView', () => {
  it('shows an empty table while filters remain unset', () => {
    renderFiles({ records: [], filters: {} });

    expect(screen.getByText(t.sections.files.noFiles)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: t.sections.files.search })).toHaveValue('');
    expect(screen.getAllByRole('combobox')).toHaveLength(2);
  });

  it('filters files and categories through their visible controls', async () => {
    const user = userEvent.setup();
    const filters: FilesListInput = { query: 'old', categoryPath: '', type: '' };
    const handlers = renderFiles({ filters });

    const search = screen.getByRole('textbox', { name: t.sections.files.search });
    fireEvent.change(search, { target: { value: 'report' } });
    expect(handlers.onFiltersChange).toHaveBeenLastCalledWith({ ...filters, query: 'report' });

    const [categorySelect, typeSelect] = screen.getAllByRole('combobox');
    await user.click(categorySelect);
    await user.click(screen.getByRole('option', { name: 'Invoices' }));
    expect(handlers.onFiltersChange).toHaveBeenCalledWith({ ...filters, categoryPath: 'invoices' });

    await user.click(typeSelect);
    await user.click(screen.getByRole('option', { name: 'application/pdf' }));
    expect(handlers.onFiltersChange).toHaveBeenCalledWith({ ...filters, type: 'application/pdf' });

    await user.click(screen.getByRole('button', { name: t.sections.files.createCategory }));
    expect(handlers.onCreateCategory).toHaveBeenCalledOnce();
  });

  it('formats file metadata and keeps category and file actions independent', async () => {
    const user = userEvent.setup();
    const handlers = renderFiles();

    expect(screen.getAllByText('0 B')).toHaveLength(2);
    expect(screen.getByText('512 B')).toBeInTheDocument();
    expect(screen.getByText('2.0 KB')).toBeInTheDocument();
    expect(screen.getByText('2.0 MB')).toBeInTheDocument();
    expect(screen.getByText('2.0 GB')).toBeInTheDocument();
    expect(screen.getAllByText('-')).toHaveLength(2);
    expect(screen.getAllByText('Invoices').length).toBeGreaterThan(1);
    expect(screen.getByText('unknown')).toBeInTheDocument();
    expect(screen.getAllByText(t.sections.files.root).length).toBeGreaterThan(0);

    const categoryChip = screen.getAllByText('Invoices').find((entry) => entry.tagName === 'SPAN')?.closest('.MuiStack-root') as HTMLElement;
    const categoryButtons = within(categoryChip).getAllByRole('button');
    await user.click(categoryButtons[0]);
    await user.click(categoryButtons[1]);
    expect(handlers.onRenameCategory).toHaveBeenCalledWith('invoices');
    expect(handlers.onDeleteCategory).toHaveBeenCalledWith('invoices');

    const fileRow = screen.getByText('bytes.txt').closest('tr') as HTMLElement;
    const fileButtons = within(fileRow).getAllByRole('button');
    await user.click(fileButtons[0]);
    await user.click(fileButtons[1]);
    await user.click(fileButtons[2]);
    expect(handlers.onRenameFile).toHaveBeenCalledWith(files[2]);
    expect(handlers.onMoveFile).toHaveBeenCalledWith(files[2]);
    expect(handlers.onDeleteFile).toHaveBeenCalledWith(files[2]);
  });
});
