import { describe, expect, it } from 'vitest';
import { detectSecret, detectSecretInDoc, isPlaceholder, looksRandom, shannonEntropy } from './secrets.js';

// Test fixtures are assembled at runtime so this file never contains a
// literal that secret scanners would flag.
const j = (...parts: string[]) => parts.join('');
const AWS_ID = j('AKIA', 'Z7Q4', 'M2XK', 'P9RT', 'W3LB');
const AWS_SECRET = j('wJalrXUtnFEMI/K7MDENG/', 'bPxRfiCYzq8Rk2Lm4N');
const GH = j('ghp_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8');
const RANDOM = j('Zq8', 'xT2', 'vLm9', 'Rk4p', 'Wb7N', 'sY3c');

describe('detectSecret: positives', () => {
  const cases: Array<[string, string]> = [
    ['private_key_block', j('-----BEGIN ', 'RSA PRIVATE KEY-----\nMIIE...')],
    ['private_key_block', j('-----BEGIN ', 'PRIVATE KEY-----')],
    ['private_key_block', j('-----BEGIN ', 'OPENSSH PRIVATE KEY-----')],
    ['private_key_block', j('-----BEGIN ', 'PGP PRIVATE KEY BLOCK-----')],
    ['aws_access_key_id', `creds: ${AWS_ID} for the bucket`],
    ['aws_secret_access_key', `aws_secret_access_key = ${AWS_SECRET}`],
    ['database_url_with_password', j('postgres://yapa:', 'S3cr3tPassw0rd', '@db.example.internal:5432/yapa')],
    ['database_url_with_password', j('postgresql://admin:', 'hunter2x', '@db.internal/app')],
    ['database_url_with_password', j('mongodb+srv://u:', 'p4ssW0rd', '@cluster0.example.net')],
    ['github_token', `token ${GH}`],
    ['slack_token', j('xoxb-', '1234567890-abcdefghij')],
    ['google_api_key', j('AIza', 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q')],
    ['credential_assignment', `password=${RANDOM}`],
    ['credential_assignment', `export API_KEY="${RANDOM}"`],
    ['credential_assignment', `token: ${RANDOM}`],
    ['credential_assignment', `client_secret = '${RANDOM}'`],
  ];
  for (const [pattern, text] of cases) {
    it(`${pattern}: ${text.slice(0, 24)}...`, () => {
      expect(detectSecret(text)?.pattern).toBe(pattern);
    });
  }
});

describe('detectSecret: negatives (conservative)', () => {
  const cases = [
    'Customer asked about request.timeout.ms and session.timeout.ms; we suggested 60000.',
    'Connect with postgres://user:pass@host:5432/yapa (replace with your values)',
    'Use postgres://yapa:${YAPA_PG_PASS}@localhost:5432/yapa in the env file',
    'postgres://yapa:<password>@<endpoint>:5432/yapa',
    'postgres://yapa:[YOUR-PASSWORD]@db.example.com:5432/postgres',
    'postgres://localhost:5432/yapa has no credentials',
    'The password is stored in Secret Manager, not here.',
    'password: changeme',
    'token=${GITHUB_TOKEN}',
    'max_tokens: 4096 and token_budget=200000',
    'api_key = <your-api-key-here>',
    'secret: retrieved-from-vault-at-runtime',
    'commit 7dac220d4b1e9f0a and sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    'Ask AKIA in the meeting', // not a key shape
    '-----BEGIN PUBLIC KEY-----',
    '-----BEGIN CERTIFICATE-----',
    'token: /var/run/secrets/kubernetes.io/serviceaccount/token',
    'device id 6f1c2b8e-3d4a-4f5b-9c6d-7e8f9a0b1c2d',
  ];
  for (const text of cases) {
    it(text.slice(0, 50), () => {
      expect(detectSecret(text)).toBeUndefined();
    });
  }
});

describe('helpers', () => {
  it('placeholders', () => {
    for (const p of ['<password>', '${PG_PASS}', '$PG_PASS', '***', 'xxxx', 'changeme', '[YOUR-PASSWORD]', '%PASS%']) {
      expect(isPlaceholder(p)).toBe(true);
    }
    expect(isPlaceholder('S3cr3tPassw0rd')).toBe(false);
  });

  it('entropy and randomness', () => {
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy('abcd')).toBe(2);
    expect(looksRandom(RANDOM)).toBe(true);
    expect(looksRandom('retrieved-from-vault-at-runtime')).toBe(false);
    expect(looksRandom('short1A')).toBe(false);
  });

  it('scans metadata string values too, reporting only the pattern name', () => {
    const hit = detectSecretInDoc('a harmless task', { title: 'rotate', description: `use ${AWS_ID}`, tags: ['x'] });
    expect(hit).toEqual({ pattern: 'aws_access_key_id' });
    expect(detectSecretInDoc('fine', { nested: { list: ['ok', { deep: GH }] } })?.pattern).toBe('github_token');
    expect(detectSecretInDoc('fine', { type: 'task', status: 'pending' })).toBeUndefined();
  });
});
