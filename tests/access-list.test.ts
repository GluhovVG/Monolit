import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseEmailList } from '../backend/email-list.ts';

describe('ALLOWED_EMAILS access list', () => {
  it('splits by commas, spaces and newlines, lowercases and de-duplicates', () => {
    assert.deepEqual(
      parseEmailList(' Boss@Example.com, staff@example.com\nboss@example.com ;x@y.ru'),
      ['boss@example.com', 'staff@example.com', 'x@y.ru']
    );
  });
  it('drops values that are not emails, so an empty or broken secret grants nobody', () => {
    assert.deepEqual(parseEmailList(''), []);
    assert.deepEqual(parseEmailList('admin, @, a@b'), []);
  });
});
