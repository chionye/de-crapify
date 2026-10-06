// A healthy utility module: many small, independent helpers. Must NOT be flagged as a god file.

export const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

export const pluralize = (word: string, count: number): string => (count === 1 ? word : `${word}s`);

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

export function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function groupBy<T, K extends string>(items: T[], key: (item: T) => K): Record<K, T[]> {
  const result = {} as Record<K, T[]>;
  for (const item of items) (result[key(item)] ??= []).push(item);
  return result;
}

export function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

export function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function isEmail(text: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let value = bytes;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const key of keys) result[key] = obj[key];
  return result;
}

export function omit<T extends object, K extends keyof T>(obj: T, keys: K[]): Omit<T, K> {
  const result = { ...obj };
  for (const key of keys) delete result[key];
  return result;
}
