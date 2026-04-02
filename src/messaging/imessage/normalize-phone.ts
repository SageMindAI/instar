/**
 * Phone number normalization — E.164 format for consistent comparison.
 *
 * Prevents bypass via formatting tricks:
 *   "+1-256-283-3341" vs "12562833341" vs "+12562833341"
 * All normalize to "+12562833341".
 */

/**
 * Normalize a phone number or email to a canonical form for comparison.
 *
 * Phone numbers → E.164 format (+countrycode followed by digits)
 * Emails → lowercased, trimmed
 *
 * @param identifier Phone number or email address
 * @param defaultCountryCode Country code to prepend if missing (default: "1" for US)
 */
export function normalizeIdentifier(identifier: string, defaultCountryCode = '1'): string {
  const trimmed = identifier.trim();

  // Email addresses — just lowercase
  if (trimmed.includes('@')) {
    return trimmed.toLowerCase();
  }

  // Phone number normalization
  let digits = trimmed.replace(/[\s\-().]/g, '');

  // Replace leading 00 with +
  if (digits.startsWith('00')) {
    digits = '+' + digits.slice(2);
  }

  // Strip leading + for digit counting, add back later
  const hasPlus = digits.startsWith('+');
  if (hasPlus) {
    digits = digits.slice(1);
  }

  // Remove any remaining non-digit characters
  digits = digits.replace(/\D/g, '');

  // If 10 digits and starts with area code (US assumption), prepend country code
  if (digits.length === 10 && !hasPlus) {
    digits = defaultCountryCode + digits;
  }

  // Always return with + prefix
  return '+' + digits;
}

/**
 * Normalize a set of identifiers for consistent lookup.
 */
export function normalizeIdentifierSet(identifiers: string[]): Set<string> {
  return new Set(identifiers.map(id => normalizeIdentifier(id)));
}

/**
 * Check if two identifiers match after normalization.
 */
export function identifiersMatch(a: string, b: string): boolean {
  return normalizeIdentifier(a) === normalizeIdentifier(b);
}
