import groupBy from 'lodash/groupBy';
import { debounce } from 'lodash';
import { formatName } from '@acme/shared';
import { slugify } from '@acme/utils';
import { createServer } from 'http';

export function summarize(users) {
  return Object.entries(groupBy(users, 'team')).map(([team, members]) => ({
    team,
    slug: slugify(team),
    names: members.map(formatName),
  }));
}

export const onResize = debounce(() => {}, 100);
export { createServer };
