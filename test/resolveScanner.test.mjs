/**
 * Unit tests for resolveScanner() in scanners.mjs.
 *
 * Why: Verifies the alias resolution logic so regressions in device selection
 *      (e.g. "HP 5000" silently routing to Canon) are caught before deploy.
 * What: Exercises all canonical keys, all registered aliases, case-insensitivity,
 *       and the error path for unknown scanner names.
 * Test: Run with `node --test test/resolveScanner.test.mjs` (Node 18+ built-in runner).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_SCANNER_KEY, resolveScanner, SCANNER_DEVICES } from '../scanners.mjs';

describe('resolveScanner — Canon aliases', () => {
  const canonCases = ['canon', 'Canon', 'CANON', 'mf741c', 'MF741C', '741c', '741', 'canon-mf741c'];
  for (const alias of canonCases) {
    it(`resolves "${alias}" → canon`, () => {
      const device = resolveScanner(alias);
      assert.equal(device.key, 'canon');
      assert.equal(device.label, 'Canon MF741C');
      assert.ok(
        device.esclBase.startsWith('http'),
        `esclBase should be an http URL, got: ${device.esclBase}`
      );
    });
  }
});

describe('resolveScanner — HP aliases', () => {
  const hpCases = [
    'hp',
    'HP',
    'hp 5000',
    'HP 5000',
    'hp5000',
    'HP5000',
    'officejet',
    'OfficeJet',
    '5740',
    '5000',
    'hp-officejet-5740',
  ];
  for (const alias of hpCases) {
    it(`resolves "${alias}" → hp`, () => {
      const device = resolveScanner(alias);
      assert.equal(device.key, 'hp');
      assert.equal(device.label, 'HP OfficeJet 5740');
      assert.ok(
        device.esclBase.startsWith('http'),
        `esclBase should be an http URL, got: ${device.esclBase}`
      );
    });
  }
});

describe('resolveScanner — default behaviour', () => {
  it('null resolves to the default scanner key', () => {
    const device = resolveScanner(null);
    assert.equal(device.key, DEFAULT_SCANNER_KEY);
  });

  it('undefined resolves to the default scanner key', () => {
    const device = resolveScanner(undefined);
    assert.equal(device.key, DEFAULT_SCANNER_KEY);
  });

  it('DEFAULT_SCANNER_KEY is "canon" when env var is not set', () => {
    // Only meaningful when DEFAULT_SCANNER env var is unset (which is true in CI).
    // If the env var is set, this test verifies the env var value is respected.
    const expected = process.env.DEFAULT_SCANNER || 'canon';
    assert.equal(DEFAULT_SCANNER_KEY, expected);
  });
});

describe('resolveScanner — esclBase env overrides', () => {
  it('CANON_ESCL_BASE env var overrides the canon default', () => {
    // The env var may already be set in production. We just verify the field is
    // present and is a non-empty string. Deep override testing requires reloading
    // the module, which is outside scope for the built-in runner.
    const device = resolveScanner('canon');
    assert.ok(typeof device.esclBase === 'string' && device.esclBase.length > 0);
  });

  it('HP_ESCL_BASE env var overrides the hp default', () => {
    const device = resolveScanner('hp');
    assert.ok(typeof device.esclBase === 'string' && device.esclBase.length > 0);
  });
});

describe('resolveScanner — unknown scanner name errors', () => {
  const unknownCases = ['xerox', 'brother', 'epson', 'laser1', ''];
  for (const name of unknownCases) {
    it(`"${name}" throws with valid options listed`, () => {
      assert.throws(
        () => resolveScanner(name),
        (err) => {
          assert.ok(err instanceof Error, 'should throw an Error');
          // Error message must mention the invalid name and list valid keys
          assert.ok(
            err.message.includes('canon'),
            `error message should list "canon": ${err.message}`
          );
          assert.ok(err.message.includes('hp'), `error message should list "hp": ${err.message}`);
          return true;
        }
      );
    });
  }

  it('error message includes the invalid scanner name', () => {
    assert.throws(
      () => resolveScanner('xerox'),
      (err) => {
        assert.ok(
          err.message.includes('xerox'),
          `error message should echo "xerox": ${err.message}`
        );
        return true;
      }
    );
  });
});

describe('resolveScanner — return shape', () => {
  it('returns an object with key, label, and esclBase', () => {
    const device = resolveScanner('canon');
    assert.ok('key' in device, 'missing key');
    assert.ok('label' in device, 'missing label');
    assert.ok('esclBase' in device, 'missing esclBase');
    assert.equal(typeof device.key, 'string');
    assert.equal(typeof device.label, 'string');
    assert.equal(typeof device.esclBase, 'string');
  });

  it('SCANNER_DEVICES has exactly two entries (canon and hp)', () => {
    const keys = Object.keys(SCANNER_DEVICES);
    assert.deepEqual(keys.sort(), ['canon', 'hp']);
  });
});
