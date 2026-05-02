import type { ForgerFileCategory } from '@shared/types';

export const formatBytes = (value: number): string => {
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

export const compactFileName = (name: string): string => {
  const dotIndex = name.lastIndexOf('.');
  const extension = dotIndex > 0 ? name.slice(dotIndex) : '';
  const base = dotIndex > 0 ? name.slice(0, dotIndex) : name;
  const maxBaseLength = extension ? 18 : 24;
  return base.length > maxBaseLength ? `${base.slice(0, maxBaseLength).trim()}...${extension}` : name;
};

export const compactCategoryLabel = (
  value: string,
  categories: ForgerFileCategory[],
  rootLabel: string,
): string => {
  if (!value) {
    return rootLabel;
  }
  return categories.find((category) => category.path === value)?.name ?? value.split('/').join(' / ');
};
