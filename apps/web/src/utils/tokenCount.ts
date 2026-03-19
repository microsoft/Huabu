import { encode } from 'gpt-tokenizer';

/**
 * Return the number of tokens for a given text string.
 * Uses the o200k_base tokenizer (GPT-4o / GPT-5.x family).
 */
export function countTokens(text: string): number {
  if (!text) return 0;
  return encode(text).length;
}
