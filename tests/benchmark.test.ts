import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeTokPerSec,
  nsToSec,
  resolveInstalledModel,
} from '../scripts/benchmark-utils.js';

test('resolveInstalledModel: exact match', () => {
  assert.equal(resolveInstalledModel('gemma4:latest', ['gemma4:latest', 'other:tag']), 'gemma4:latest');
});

test('resolveInstalledModel: bare name picks :latest', () => {
  assert.equal(resolveInstalledModel('gemma4', ['gemma4:latest', 'gemma4:26b']), 'gemma4:latest');
});

test('resolveInstalledModel: bare name without :latest uses first match', () => {
  assert.equal(resolveInstalledModel('foo', ['foo:26b', 'foo:31b']), 'foo:26b');
});

test('resolveInstalledModel: unknown leaves requested', () => {
  assert.equal(resolveInstalledModel('missing', ['a:b']), 'missing');
});

test('nsToSec', () => {
  assert.equal(nsToSec(1e9), 1);
  assert.equal(nsToSec(undefined), 0);
});

test('decodeTokPerSec', () => {
  assert.equal(decodeTokPerSec(100, 1e9), 100);
  assert.equal(decodeTokPerSec(0, 1e9), 0);
  assert.equal(decodeTokPerSec(10, 0), 0);
});
