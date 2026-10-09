import { describe, it, expect } from 'vitest';
import { buildRemoteDocsSinceQuery } from './postgres.js';

describe('buildRemoteDocsSinceQuery', () => {
  const self = { user: 'josh', device: 'dev-A' };

  it('skips only this device\'s writes plus this user\'s pre-device legacy rows', () => {
    const q = buildRemoteDocsSinceQuery('project-acme', 100, self);
    expect(q.values).toEqual(['project-acme', 100, 'josh', 'dev-A']);
    expect(q.text).toContain(`COALESCE(metadata->>'origin_device', '') <> $4`);
    expect(q.text).toContain(`NOT (origin_user = $3 AND metadata->>'origin_device' IS NULL)`);
    // Not the old blanket "origin_user != me" filter, which blocked a user's own other machines.
    expect(q.text).not.toMatch(/origin_user\s*!=\s*\$3/);
    expect(q.text).not.toContain('AND origin_user = $3\n');
  });

  it('restricts personal collections to the user\'s own rows', () => {
    const q = buildRemoteDocsSinceQuery('global', 0, self, { onlyOwnRows: true });
    expect(q.text).toMatch(/AND origin_user = \$3\s+ORDER BY/);
  });

  it('drops the echo filters only for a recovery pull', () => {
    const q = buildRemoteDocsSinceQuery('customer-lost', 0, self, { includeOwnDevice: true });
    expect(q.text).not.toContain('origin_device');
  });
});
