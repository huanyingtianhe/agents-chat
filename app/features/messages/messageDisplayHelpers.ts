export function getStatusDisplayText(label: string | undefined, fallback: string): string {
  const trimmed = label?.trim() || '';
  return /[A-Za-z0-9]/.test(trimmed) ? trimmed : fallback;
}
