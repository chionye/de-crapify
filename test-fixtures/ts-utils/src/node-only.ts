// Plain module with no decorators, to make sure a TS file without JSX parses as .ts
export function loadTemplate(path: string): string {
  return path;
}
