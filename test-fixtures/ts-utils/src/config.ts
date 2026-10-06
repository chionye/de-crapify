export interface Config {
  locale: string;
  currency: string;
}

export function loadConfig(): Config {
  return { locale: 'en-US', currency: 'USD' };
}
