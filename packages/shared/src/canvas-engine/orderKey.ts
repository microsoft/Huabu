// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Order keys: strings that sort like the positions they stand for, with
 * room for a new key between any two.
 *
 * A node carries its own key (`data.paintKey` among its siblings,
 * `data.trackKey` inside its Column / Row track), so moving one node writes
 * one node. Keys compare as plain code units over `0-9A-Za-z`.
 *
 * The format is the fractional index of the `fractional-indexing` package
 * (CC0): a head character giving the length of the integer part (`a`-`z`
 * positive, `A`-`Z` negative), the integer digits, then an optional fraction
 * that never ends in `0`.
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ZERO = DIGITS[0];
const SMALLEST_INTEGER = `A${ZERO.repeat(26)}`;
const INTEGER_ZERO = `a${ZERO}`;

function integerLength(head: string): number {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 95;
  if (head >= 'A' && head <= 'Z') return 92 - head.charCodeAt(0);
  throw new Error(`Invalid order key head: ${head}`);
}

function integerPart(key: string): string {
  const length = integerLength(key[0]);
  if (length > key.length) throw new Error(`Invalid order key: ${key}`);
  return key.slice(0, length);
}

/** Whether `value` is a key this module could have produced. */
export function isOrderKey(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value === SMALLEST_INTEGER) return false;
  for (const char of value) if (!DIGITS.includes(char)) return false;
  const head = value[0];
  if (!((head >= 'a' && head <= 'z') || (head >= 'A' && head <= 'Z')))
    return false;
  if (integerLength(head) > value.length) return false;
  return !value.slice(integerLength(head)).endsWith(ZERO);
}

/** A fraction strictly between `a` and `b` (`b` undefined: no upper bound). */
function midpoint(a: string, b: string | undefined): string {
  if (b !== undefined) {
    // Shared prefix, treating `a` as padded with zeros.
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a[0]) : 0;
  const digitB = b !== undefined ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (digitB - digitA > 1) return DIGITS[Math.round(0.5 * (digitA + digitB))];
  if (b !== undefined && b.length > 1) return b.slice(0, 1);
  return DIGITS[digitA] + midpoint(a.slice(1), undefined);
}

function incrementInteger(x: string): string | undefined {
  const [head, ...digits] = x.split('');
  let carry = true;
  for (let i = digits.length - 1; carry && i >= 0; i--) {
    const d = DIGITS.indexOf(digits[i]) + 1;
    if (d === DIGITS.length) digits[i] = ZERO;
    else {
      digits[i] = DIGITS[d];
      carry = false;
    }
  }
  if (!carry) return head + digits.join('');
  if (head === 'Z') return INTEGER_ZERO;
  if (head === 'z') return undefined;
  const next = String.fromCharCode(head.charCodeAt(0) + 1);
  if (next > 'a') digits.push(ZERO);
  else digits.pop();
  return next + digits.join('');
}

function decrementInteger(x: string): string | undefined {
  const [head, ...digits] = x.split('');
  let borrow = true;
  for (let i = digits.length - 1; borrow && i >= 0; i--) {
    const d = DIGITS.indexOf(digits[i]) - 1;
    if (d === -1) digits[i] = DIGITS[DIGITS.length - 1];
    else {
      digits[i] = DIGITS[d];
      borrow = false;
    }
  }
  if (!borrow) return head + digits.join('');
  if (head === 'a') return `Z${DIGITS[DIGITS.length - 1]}`;
  if (head === 'A') return undefined;
  const next = String.fromCharCode(head.charCodeAt(0) - 1);
  if (next < 'Z') digits.push(DIGITS[DIGITS.length - 1]);
  else digits.pop();
  return next + digits.join('');
}

/**
 * A key strictly between `a` and `b`. `undefined` stands for "no bound":
 * before every key, or after every key.
 *
 * @throws when `a >= b`, or a bound is not an order key.
 */
export function keyBetween(
  a: string | undefined,
  b: string | undefined,
): string {
  if (a !== undefined && !isOrderKey(a))
    throw new Error(`Invalid order key: ${a}`);
  if (b !== undefined && !isOrderKey(b))
    throw new Error(`Invalid order key: ${b}`);
  if (a !== undefined && b !== undefined && a >= b)
    throw new Error(`Order keys out of order: ${a} >= ${b}`);
  if (a === undefined) {
    if (b === undefined) return INTEGER_ZERO;
    const intB = integerPart(b);
    const fracB = b.slice(intB.length);
    if (intB === SMALLEST_INTEGER) return intB + midpoint('', fracB);
    if (intB < b) return intB;
    const lower = decrementInteger(intB);
    if (lower === undefined) throw new Error('Order key range exhausted');
    return lower;
  }
  const intA = integerPart(a);
  const fracA = a.slice(intA.length);
  if (b === undefined) {
    const higher = incrementInteger(intA);
    return higher ?? intA + midpoint(fracA, undefined);
  }
  const intB = integerPart(b);
  const fracB = b.slice(intB.length);
  if (intA === intB) return intA + midpoint(fracA, fracB);
  const higher = incrementInteger(intA);
  if (higher === undefined) throw new Error('Order key range exhausted');
  if (higher < b) return higher;
  return intA + midpoint(fracA, undefined);
}

/** `n` ascending keys strictly between `a` and `b`, evenly spread. */
export function keysBetween(
  a: string | undefined,
  b: string | undefined,
  n: number,
): string[] {
  if (n <= 0) return [];
  if (n === 1) return [keyBetween(a, b)];
  if (b === undefined) {
    const keys = [keyBetween(a, b)];
    for (let i = 1; i < n; i++) keys.push(keyBetween(keys[i - 1], b));
    return keys;
  }
  if (a === undefined) {
    const keys = [keyBetween(a, b)];
    for (let i = 1; i < n; i++) keys.push(keyBetween(a, keys[i - 1]));
    return keys.reverse();
  }
  const middle = Math.floor(n / 2);
  const key = keyBetween(a, b);
  return [
    ...keysBetween(a, key, middle),
    key,
    ...keysBetween(key, b, n - middle - 1),
  ];
}

/**
 * Keys for a sequence that must end up strictly ascending, changing as few
 * as possible. An entry keeps its key when it is an order key greater than
 * the last one kept; every other entry (no key, an equal key, a key out of
 * place) gets a new key between its kept neighbours.
 *
 * Deterministic: the same input always yields the same keys, which is what
 * lets a Space stored before keys existed be read the same way twice.
 */
export function keysInSequence(
  keys: readonly (string | undefined)[],
): string[] {
  const result: string[] = [];
  let lower: string | undefined;
  let index = 0;
  while (index < keys.length) {
    const key = keys[index];
    if (isOrderKey(key) && (lower === undefined || key > lower)) {
      result.push(key);
      lower = key;
      index++;
      continue;
    }
    // The run of entries to re-key ends at the next key that can be kept.
    let end = index + 1;
    while (end < keys.length) {
      const candidate = keys[end];
      if (isOrderKey(candidate) && (lower === undefined || candidate > lower))
        break;
      end++;
    }
    const fresh = keysBetween(lower, keys[end], end - index);
    result.push(...fresh);
    lower = fresh[fresh.length - 1];
    index = end;
  }
  return result;
}

/** Order by key, then by id: two equal keys still order the same everywhere. */
export function compareOrder(
  a: { key: string | undefined; id: string },
  b: { key: string | undefined; id: string },
): number {
  const keyA = a.key ?? '';
  const keyB = b.key ?? '';
  if (keyA !== keyB) return keyA < keyB ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
