import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  FilesActionResult,
  FilesCreateCategoryInput,
  FilesDeleteCategoryInput,
  FilesDeleteInput,
  FilesImportInput,
  FilesListInput,
  FilesMoveInput,
  FilesRenameCategoryInput,
  FilesRenameInput,
  ForgerFileCategory,
  ForgerFileRecord,
  PickedChatFile,
} from '../shared/types';

interface StoredFileIndex {
  files: ForgerFileRecord[];
  categories: ForgerFileCategory[];
}

const EMPTY_INDEX: StoredFileIndex = {
  files: [],
  categories: [],
};

const TYPE_BY_EXTENSION: Record<string, string> = {
  '.csv': 'spreadsheet',
  '.tsv': 'spreadsheet',
  '.xls': 'spreadsheet',
  '.xlsx': 'spreadsheet',
  '.pdf': 'pdf',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.webp': 'image',
  '.gif': 'image',
  '.txt': 'text',
  '.md': 'text',
  '.json': 'data',
  '.xml': 'data',
  '.doc': 'document',
  '.docx': 'document',
};

export class FileLibrary {
  public constructor(
    private readonly dataRoot: string,
    private readonly metadataRoot: string,
  ) {}

  public async pickFileInfo(filePaths: string[]): Promise<PickedChatFile[]> {
    const picked: PickedChatFile[] = [];
    for (const filePath of filePaths) {
      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat?.isFile()) {
        continue;
      }
      picked.push({
        sourcePath: filePath,
        name: path.basename(filePath),
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        type: inferType(filePath),
      });
    }
    return picked;
  }

  public async list(input: FilesListInput = {}): Promise<ForgerFileRecord[]> {
    const index = await this.readIndex();
    const query = input.query?.trim().toLowerCase() ?? '';
    const rootOnly = input.categoryPath === '__root';
    const categoryPath = rootOnly ? '' : normalizeCategoryPath(input.categoryPath ?? '');
    const type = input.type?.trim() ?? '';

    const existing = await this.scanFiles(index);
    await this.writeIndex({ ...index, files: existing });

    const filtered = existing.filter((file) => {
      if (query && !file.name.toLowerCase().includes(query) && !file.relativePath.toLowerCase().includes(query)) {
        return false;
      }
      if (rootOnly && file.categoryPath) {
        return false;
      }
      if (!rootOnly && categoryPath && file.categoryPath !== categoryPath) {
        return false;
      }
      if (type && file.type !== type) {
        return false;
      }
      return true;
    });

    const sortBy = input.sortBy ?? 'uploadedAt';
    const direction = input.sortDirection ?? 'desc';
    return filtered.sort((a, b) => {
      const multiplier = direction === 'asc' ? 1 : -1;
      if (sortBy === 'sizeBytes') {
        return (a.sizeBytes - b.sizeBytes) * multiplier;
      }
      return String(a[sortBy]).localeCompare(String(b[sortBy])) * multiplier;
    });
  }

  public async listCategories(): Promise<ForgerFileCategory[]> {
    const index = await this.readIndex();
    const diskCategories = await this.scanCategories('');
    const byPath = new Map<string, ForgerFileCategory>();
    for (const category of [...index.categories, ...diskCategories]) {
      if (category.path && !category.path.includes('/')) {
        byPath.set(category.path, category);
      }
    }
    const categories = [...byPath.values()]
      .map((category) => ({
        ...category,
        name: category.path.split('/').filter(Boolean).join(' / ') || category.name,
        parentPath: '',
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
    await this.writeIndex({ ...index, categories });
    return categories;
  }

  public async createCategory(input: FilesCreateCategoryInput): Promise<ForgerFileCategory> {
    const name = sanitizeSegment(input.name);
    if (!name) {
      throw new Error('invalid_category_name');
    }
    const parentPath = '';
    const categoryPath = normalizeCategoryPath(name);
    const fullPath = await this.resolveDataPath(categoryPath);
    await fs.mkdir(fullPath, { recursive: true });
    const stat = await fs.stat(fullPath);
    const category: ForgerFileCategory = {
      path: categoryPath,
      name,
      parentPath,
      createdAt: stat.birthtime.toISOString(),
      modifiedAt: stat.mtime.toISOString(),
    };
    const index = await this.readIndex();
    const categories = [...index.categories.filter((item) => item.path !== category.path), category];
    await this.writeIndex({ ...index, categories });
    return category;
  }

  public async renameCategory(input: FilesRenameCategoryInput): Promise<FilesActionResult> {
    const categoryPath = normalizeCategoryPath(input.categoryPath);
    const nextName = sanitizeSegment(input.newName);
    if (!categoryPath || !nextName) {
      return { success: false, technicalCode: 'invalid_category' };
    }

    const parentPath = path.posix.dirname(categoryPath) === '.' ? '' : path.posix.dirname(categoryPath);
    const nextPath = normalizeCategoryPath(parentPath ? `${parentPath}/${nextName}` : nextName);
    const source = await this.resolveDataPath(categoryPath);
    const target = await this.resolveAvailableDataPath(nextPath, true);
    await fs.rename(source, target.absolutePath);

    const index = await this.readIndex();
    const updatePath = (value: string) =>
      value === categoryPath ? target.relativePath : value.startsWith(`${categoryPath}/`) ? `${target.relativePath}/${value.slice(categoryPath.length + 1)}` : value;

    await this.writeIndex({
      files: index.files.map((file) => ({
        ...file,
        categoryPath: updatePath(file.categoryPath),
        relativePath: updatePath(file.relativePath),
      })),
      categories: index.categories
        .map((category) => ({
          ...category,
          path: updatePath(category.path),
          parentPath: updatePath(category.parentPath),
          name: updatePath(category.path).split('/').pop() ?? category.name,
        }))
        .filter((category, indexPosition, categories) => category.path && categories.findIndex((item) => item.path === category.path) === indexPosition),
    });
    return { success: true, userMessage: 'Categoria renombrada.' };
  }

  public async deleteCategory(input: FilesDeleteCategoryInput): Promise<FilesActionResult> {
    const categoryPath = normalizeCategoryPath(input.categoryPath);
    if (!categoryPath || input.mode !== 'emptyOnly') {
      return { success: false, technicalCode: 'invalid_category' };
    }
    const index = await this.readIndex();
    const refreshed = await Promise.all(index.files.map((file) => this.refreshFileStats(file)));
    const existingFiles = refreshed.filter((file): file is ForgerFileRecord => Boolean(file));
    const hasTrackedFiles = existingFiles.some(
      (file) => file.categoryPath === categoryPath || file.categoryPath.startsWith(`${categoryPath}/`),
    );
    const hasUserFilesOnDisk = await this.directoryHasUserFiles(categoryPath);
    if (hasTrackedFiles || hasUserFilesOnDisk) {
      if (existingFiles.length !== index.files.length) {
        await this.writeIndex({ ...index, files: existingFiles });
      }
      return { success: false, userMessage: 'La categoria tiene archivos.', technicalCode: 'category_not_empty' };
    }
    await fs.rm(await this.resolveDataPath(categoryPath), { recursive: true, force: true });
    await this.writeIndex({
      files: existingFiles,
      categories: index.categories.filter(
        (category) => category.path !== categoryPath && !category.path.startsWith(`${categoryPath}/`),
      ),
    });
    return { success: true, userMessage: 'Categoria eliminada.' };
  }

  public async importFiles(input: FilesImportInput): Promise<ForgerFileRecord[]> {
    const categoryPath = normalizeCategoryPath(input.categoryPath ?? '');
    await fs.mkdir(await this.resolveDataPath(categoryPath), { recursive: true });
    const index = await this.readIndex();
    const imported: ForgerFileRecord[] = [];

    for (const sourcePath of input.sourcePaths) {
      const sourceReal = await fs.realpath(sourcePath).catch(() => null);
      if (!sourceReal) {
        continue;
      }
      const sourceStat = await fs.stat(sourceReal).catch(() => null);
      if (!sourceStat?.isFile()) {
        continue;
      }

      const originalName = sanitizeFileName(path.basename(sourceReal));
      const available = await this.resolveAvailableDataPath(categoryPath ? `${categoryPath}/${originalName}` : originalName, false);
      await fs.copyFile(sourceReal, available.absolutePath);
      const copiedStat = await fs.stat(available.absolutePath);
      imported.push({
        id: randomUUID(),
        name: path.basename(available.relativePath),
        relativePath: available.relativePath,
        categoryPath,
        sizeBytes: copiedStat.size,
        uploadedAt: new Date().toISOString(),
        modifiedAt: copiedStat.mtime.toISOString(),
        type: inferType(available.relativePath),
        appId: input.appId,
      });
    }

    await this.writeIndex({
      ...index,
      files: [...imported, ...index.files],
    });
    return imported;
  }

  public async moveFiles(input: FilesMoveInput): Promise<ForgerFileRecord[]> {
    const categoryPath = normalizeCategoryPath(input.categoryPath);
    await fs.mkdir(await this.resolveDataPath(categoryPath), { recursive: true });
    const index = await this.readIndex();
    const files = await this.scanFiles(index);
    const moved: ForgerFileRecord[] = [];
    const ids = new Set(input.fileIds);

    for (const file of files) {
      if (!ids.has(file.id)) {
        continue;
      }
      const target = await this.resolveAvailableDataPath(categoryPath ? `${categoryPath}/${file.name}` : file.name, false);
      await fs.rename(await this.resolveDataPath(file.relativePath), target.absolutePath);
      const stat = await fs.stat(target.absolutePath);
      moved.push({
        ...file,
        name: path.basename(target.relativePath),
        relativePath: target.relativePath,
        categoryPath,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      });
    }

    await this.writeIndex({
      ...index,
      files: files.map((file) => moved.find((item) => item.id === file.id) ?? file),
    });
    return moved;
  }

  public async renameFile(input: FilesRenameInput): Promise<ForgerFileRecord> {
    const index = await this.readIndex();
    const files = await this.scanFiles(index);
    const file = files.find((item) => item.id === input.fileId);
    if (!file) {
      throw new Error('file_not_found');
    }
    const extension = path.extname(file.name);
    const rawName = sanitizeFileName(input.name);
    const nextName = path.extname(rawName) ? rawName : `${rawName}${extension}`;
    const target = await this.resolveAvailableDataPath(file.categoryPath ? `${file.categoryPath}/${nextName}` : nextName, false);
    await fs.rename(await this.resolveDataPath(file.relativePath), target.absolutePath);
    const stat = await fs.stat(target.absolutePath);
    const renamed: ForgerFileRecord = {
      ...file,
      name: path.basename(target.relativePath),
      relativePath: target.relativePath,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      type: inferType(target.relativePath),
    };
    await this.writeIndex({
      ...index,
      files: files.map((item) => (item.id === file.id ? renamed : item)),
    });
    return renamed;
  }

  public async deleteFiles(input: FilesDeleteInput): Promise<FilesActionResult> {
    const ids = new Set(input.fileIds);
    const index = await this.readIndex();
    const files = await this.scanFiles(index);
    for (const file of files) {
      if (ids.has(file.id)) {
        await fs.rm(await this.resolveDataPath(file.relativePath), { force: true });
      }
    }
    await this.writeIndex({
      ...index,
      files: files.filter((file) => !ids.has(file.id)),
    });
    return { success: true, userMessage: 'Archivos eliminados.' };
  }

  public async getFilesByIds(ids: string[], source: 'attached' | 'mentioned'): Promise<Array<ForgerFileRecord & { source: 'attached' | 'mentioned'; absolutePath: string }>> {
    const idSet = new Set(ids);
    const files = await this.list();
    const selected: Array<ForgerFileRecord & { source: 'attached' | 'mentioned'; absolutePath: string }> = [];
    for (const file of files) {
      if (!idSet.has(file.id)) {
        continue;
      }
      selected.push({
        ...file,
        source,
        absolutePath: await this.resolveDataPath(file.relativePath),
      });
    }
    return selected;
  }

  private async refreshFileStats(file: ForgerFileRecord): Promise<ForgerFileRecord | null> {
    const stat = await fs.stat(await this.resolveDataPath(file.relativePath)).catch(() => null);
    if (!stat?.isFile()) {
      return null;
    }
    return {
      ...file,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    };
  }

  private async scanFiles(index: StoredFileIndex): Promise<ForgerFileRecord[]> {
    const indexedByPath = new Map(index.files.map((file) => [file.relativePath, file]));
    const diskFiles = await this.scanFilesFromDisk('');
    return diskFiles
      .map((diskFile) => {
        const indexed = indexedByPath.get(diskFile.relativePath);
        return indexed
          ? {
              ...indexed,
              name: diskFile.name,
              categoryPath: diskFile.categoryPath,
              sizeBytes: diskFile.sizeBytes,
              modifiedAt: diskFile.modifiedAt,
              type: diskFile.type,
            }
          : diskFile;
      })
      .sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
  }

  private async scanFilesFromDisk(parentPath: string): Promise<ForgerFileRecord[]> {
    const root = await this.resolveDataPath(parentPath);
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const files: ForgerFileRecord[] = [];
    for (const entry of entries) {
      if (entry.name === '.DS_Store') {
        continue;
      }
      const relativePath = normalizeRelativePath(parentPath ? `${parentPath}/${entry.name}` : entry.name);
      if (entry.isDirectory() && !parentPath) {
        files.push(...(await this.scanFilesFromDisk(relativePath)));
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const stat = await fs.stat(await this.resolveDataPath(relativePath)).catch(() => null);
      if (!stat?.isFile()) {
        continue;
      }
      const segments = relativePath.split('/');
      files.push({
        id: `fs:${relativePath}`,
        name: entry.name,
        relativePath,
        categoryPath: segments.length > 1 ? segments.slice(0, -1).join('/') : '',
        sizeBytes: stat.size,
        uploadedAt: stat.birthtime.toISOString(),
        modifiedAt: stat.mtime.toISOString(),
        type: inferType(relativePath),
      });
    }
    return files;
  }

  private async directoryHasUserFiles(relativePath: string): Promise<boolean> {
    const absolutePath = await this.resolveDataPath(relativePath);
    const entries = await fs.readdir(absolutePath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === '.DS_Store') {
        continue;
      }
      if (entry.isFile()) {
        return true;
      }
    }
    return false;
  }

  private async readIndex(): Promise<StoredFileIndex> {
    await fs.mkdir(this.dataRoot, { recursive: true });
    await fs.mkdir(path.dirname(this.indexPath()), { recursive: true });
    const raw = await fs.readFile(this.indexPath(), 'utf8').catch(() => '');
    if (!raw) {
      return structuredClone(EMPTY_INDEX);
    }
    try {
      const parsed = JSON.parse(raw) as Partial<StoredFileIndex>;
      return {
        files: Array.isArray(parsed.files) ? parsed.files : [],
        categories: Array.isArray(parsed.categories) ? parsed.categories : [],
      };
    } catch {
      return structuredClone(EMPTY_INDEX);
    }
  }

  private async writeIndex(index: StoredFileIndex): Promise<void> {
    await fs.mkdir(path.dirname(this.indexPath()), { recursive: true });
    await fs.writeFile(this.indexPath(), JSON.stringify(index, null, 2), 'utf8');
  }

  private indexPath(): string {
    return path.join(this.metadataRoot, 'files', 'index.json');
  }

  private async scanCategories(parentPath: string): Promise<ForgerFileCategory[]> {
    const root = await this.resolveDataPath(parentPath);
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const categories: ForgerFileCategory[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const categoryPath = normalizeCategoryPath(parentPath ? `${parentPath}/${entry.name}` : entry.name);
      if (categoryPath.includes('/')) {
        continue;
      }
      const stat = await fs.stat(path.join(root, entry.name)).catch(() => null);
      categories.push({
        path: categoryPath,
        name: entry.name,
        parentPath,
        createdAt: stat?.birthtime.toISOString(),
        modifiedAt: stat?.mtime.toISOString(),
      });
    }
    return categories;
  }

  private async resolveDataPath(relativePath: string): Promise<string> {
    const normalized = normalizeRelativePath(relativePath);
    const target = path.resolve(this.dataRoot, normalized);
    const rootReal = await fs.realpath(this.dataRoot).catch(async () => {
      await fs.mkdir(this.dataRoot, { recursive: true });
      return fs.realpath(this.dataRoot);
    });
    const parent = path.dirname(target);
    const parentReal = await fs.realpath(parent).catch(async () => {
      await fs.mkdir(parent, { recursive: true });
      return fs.realpath(parent);
    });
    const resolved = path.join(parentReal, path.basename(target));
    if (!isPathInside(resolved, rootReal)) {
      throw new Error('path_outside_data_root');
    }
    return resolved;
  }

  private async resolveAvailableDataPath(relativePath: string, directory: boolean): Promise<{ absolutePath: string; relativePath: string }> {
    const normalized = normalizeRelativePath(relativePath);
    const parsed = path.posix.parse(normalized);
    let counter = 1;
    let candidate = normalized;
    while (true) {
      const absolutePath = await this.resolveDataPath(candidate);
      const exists = await fs.stat(absolutePath).then(() => true).catch(() => false);
      if (!exists) {
        if (directory) {
          await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        }
        return { absolutePath, relativePath: candidate };
      }
      counter += 1;
      const suffix = ` (${counter})`;
      candidate = path.posix.join(parsed.dir, `${parsed.name}${suffix}${parsed.ext}`);
    }
  }
}

const normalizeRelativePath = (value: string): string => {
  const normalized = value.replace(/\\/g, '/').split('/').map(sanitizeSegment).filter(Boolean).join('/');
  if (!normalized || normalized.startsWith('../') || normalized.includes('/../')) {
    return '';
  }
  return normalized;
};

const normalizeCategoryPath = (value: string): string => normalizeRelativePath(value);

const sanitizeSegment = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/[^\w.\- ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+$/, '')
    .slice(0, 120);

const sanitizeFileName = (value: string): string => {
  const parsed = path.parse(value);
  const base = sanitizeSegment(parsed.name) || 'archivo';
  const ext = sanitizeSegment(parsed.ext).replace(/\s/g, '');
  return `${base}${ext}`;
};

const inferType = (filePath: string): string => TYPE_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? 'file';

const isPathInside = (target: string, root: string): boolean => {
  const relative = path.relative(root, target);
  const normalizedRelative = process.platform === 'win32' ? relative.toLowerCase() : relative;
  return normalizedRelative === '' || (!normalizedRelative.startsWith('..') && !path.isAbsolute(relative));
};
