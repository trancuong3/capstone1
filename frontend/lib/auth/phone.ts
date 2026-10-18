/**
 * Normalizes Vietnamese national mobile numbers and explicit international
 * numbers to E.164. It intentionally rejects ambiguous local formats.
 */
export function normalizePhoneNumber(input: string): string | null {
  const compact = input.trim().replace(/[\\s().-]/g, "");
  if (!compact || !/^\\+?\\d+$/.test(compact)) return null;

  if (compact.startsWith("+")) {
    const digits = compact.slice(1);
    return digits.length >= 8 && digits.length <= 15 && !digits.startsWith("0")
      ? `+${digits}`
      : null;
  }

  if (compact.startsWith("00")) {
    const digits = compact.slice(2);
    return digits.length >= 8 && digits.length <= 15 && !digits.startsWith("0")
      ? `+${digits}`
      : null;
  }

  // Vietnam mobile numbers are entered as 0xxxxxxxxx (10 digits total).
  if (compact.startsWith("0")) {
    if (compact.length !== 10) return null;
    return `+84${compact.slice(1)}`;
  }

  // Accept the common international form without a leading plus: 84xxxxxxxxx.
  if (compact.startsWith("84") && compact.length === 11) {
    return `+${compact}`;
  }

  return null;
}

export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

export function isEmailAddress(input: string): boolean {
  const value = normalizeEmail(input);
  return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(value);
}

export function parseLoginIdentifier(
  input: string,
): { kind: "email"; value: string } | { kind: "phone"; value: string } | null {
  const value = input.trim();
  if (!value) return null;

  if (value.includes("@")) {
    return isEmailAddress(value)
      ? { kind: "email", value: normalizeEmail(value) }
      : null;
  }

  const phone = normalizePhoneNumber(value);
  return phone ? { kind: "phone", value: phone } : null;
}
