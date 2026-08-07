// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

type CryptoLike = {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
};

function getCrypto(): CryptoLike | undefined {
  return (globalThis as unknown as { crypto?: CryptoLike }).crypto;
}

function bytesToUuidV4(bytes: Uint8Array): string {
  // Per RFC 4122: set version to 4 and variant to 10xxxxxx
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(
    '',
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16,
  )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function pseudoUuidV4(): string {
  // Fallback when crypto is not available (not cryptographically secure).
  // Generates a UUID-shaped string to preserve the {type}-{uuid} contract.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function createUuid(): string {
  const crypto = getCrypto();

  if (typeof crypto?.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  if (typeof crypto?.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return bytesToUuidV4(bytes);
  }

  return pseudoUuidV4();
}

export type PrefixedId<TType extends string = string> = `${TType}-${string}`;

export function createId<TType extends string>(type: TType): PrefixedId<TType> {
  const normalized = String(type).trim();
  if (!normalized) {
    throw new Error('createId(type): type must be a non-empty string');
  }

  return `${normalized}-${createUuid()}` as PrefixedId<TType>;
}
