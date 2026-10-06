import 'reflect-metadata';
import type { User, Locale } from './types';
import { type Config, loadConfig } from './config';
import { Logger } from './logger';
import { Injectable, Memoize } from './di';
import { readFileSync } from 'node:fs';

// Identity helper with a generic arrow function (must parse in a .ts file)
export const identity = <T>(value: T): T => value;

// Pick the first defined value
export const firstDefined = <T,>(...values: (T | undefined)[]): T | undefined => values.find((v) => v !== undefined);

@Injectable()
export class UserFormatter {
  private config: Config = loadConfig();

  constructor(private readonly logger: Logger) {}

  // Format a user's display name
  @Memoize()
  displayName(user: User, locale: Locale = 'en-US'): string {
    // Log the call
    console.log('displayName', user.id);
    try {
      return new Intl.DisplayNames([locale], { type: 'language' }).of(locale) + ': ' + user.name;
    } catch (error) {
      console.error('Intl failed', error);
      return user.name;
    }
  }

  formatDate(date: Date): string {
    // @ts-expect-error -- legacy callers pass strings; Intl handles them at runtime
    return new Intl.DateTimeFormat(this.config.locale).format(date.toString());
  }
}

// de-crapify-keep
export function debugDump(user: User): void {
  // Narrating comment that must stay because of the keep marker
  console.log('debugDump', JSON.stringify(user));
}
