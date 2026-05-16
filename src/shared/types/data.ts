import type { FailureDiagnosticFields } from './base';

export interface DbListTablesResult {
  tables: string[];
  dbPath: string;
  error?: never;
}

export interface DbListTablesError {
  tables?: never;
  dbPath?: never;
  error: string;
}

export type DbListTablesResponse = DbListTablesResult | DbListTablesError;

export interface DbQueryTableResult {
  columns: string[];
  rows: unknown[][];
  total: number;
  error?: never;
}

export interface DbQueryTableError {
  columns?: never;
  rows?: never;
  total?: never;
  error: string;
}

export type DbQueryTableResponse = DbQueryTableResult | DbQueryTableError;

export interface ForgerFileRecord {
  id: string;
  name: string;
  relativePath: string;
  categoryPath: string;
  sizeBytes: number;
  uploadedAt: string;
  modifiedAt: string;
  type: string;
  appId?: string;
}

export interface ForgerFileCategory {
  path: string;
  name: string;
  parentPath: string;
  createdAt?: string;
  modifiedAt?: string;
}

export interface PickedChatFile {
  sourcePath: string;
  name: string;
  sizeBytes: number;
  modifiedAt: string;
  type: string;
  staged?: boolean;
}

export interface FilesStageForChatInput {
  name?: string;
  mimeType: string;
  dataBase64: string;
}

export interface FilesDiscardStagedForChatInput {
  sourcePaths: string[];
}

export interface FilesListInput {
  query?: string;
  categoryPath?: string;
  type?: string;
  sortBy?: 'name' | 'uploadedAt' | 'modifiedAt' | 'sizeBytes';
  sortDirection?: 'asc' | 'desc';
}

export interface FilesImportInput {
  sourcePaths: string[];
  categoryPath?: string;
  appId?: string;
}

export interface FilesMoveInput {
  fileIds: string[];
  categoryPath: string;
}

export interface FilesRenameInput {
  fileId: string;
  name: string;
}

export interface FilesDeleteInput {
  fileIds: string[];
}

export interface FilesCreateCategoryInput {
  parentPath?: string;
  name: string;
}

export interface FilesRenameCategoryInput {
  categoryPath: string;
  newName: string;
}

export interface FilesDeleteCategoryInput {
  categoryPath: string;
  mode: 'emptyOnly';
}

export interface FilesActionResult extends FailureDiagnosticFields {
  success: boolean;
  userMessage?: string;
}

export interface AppExternalFolderGrant {
  canceled: false;
  path: string;
  grantToken: string;
  expiresAt: string;
}

export interface AppExternalFolderCanceled {
  canceled: true;
}

export type AppExternalFolderSelection = AppExternalFolderGrant | AppExternalFolderCanceled;
