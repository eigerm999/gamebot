import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanPortalNumber, fromCents, shortAmount, toCents } from '../src/core/money.js';

test('toCents converts decimal strings without float drift', () => {
  assert.equal(toCents('10'), 1000);
  assert.equal(toCents('10.5'), 1050);
  assert.equal(toCents('10.05'), 1005);
  assert.equal(toCents('-0.1'), -10);
  assert.equal(toCents('0.099999999999994'), 9); // extra decimals are cut, never rounded up
  assert.equal(toCents('-0'), 0);
  assert.throws(() => toCents('1e3'));
  assert.throws(() => toCents('abc'));
});

test('fromCents formats two decimals with sign', () => {
  assert.equal(fromCents(1050), '10.50');
  assert.equal(fromCents(-10), '-0.10');
  assert.equal(fromCents(0), '0.00');
});

test('shortAmount gives the portal form format', () => {
  assert.equal(shortAmount('10.00'), '10');
  assert.equal(shortAmount('10.50'), '10.5');
  assert.equal(shortAmount('-0.10'), '-0.1');
  assert.equal(shortAmount('25'), '25');
});

test('cleanPortalNumber accepts plain decimals only', () => {
  assert.equal(cleanPortalNumber(' 100.1 '), '100.1');
  assert.equal(cleanPortalNumber('-0'), '0');
  assert.equal(cleanPortalNumber('-'), null);
  assert.equal(cleanPortalNumber(''), null);
  assert.equal(cleanPortalNumber(undefined), null);
});
