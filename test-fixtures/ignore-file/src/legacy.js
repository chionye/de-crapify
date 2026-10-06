// de-crapify-ignore-file
// This file is intentionally left as-is; de-crapify must not touch it.
import { unused } from './nowhere';
import lodash from 'not-installed-anywhere';

export function legacy(value) {
  console.log('legacy', value);
  if (value) {
    if (value > 1) {
      return value * 2;
    }
  }
  return value;
}
