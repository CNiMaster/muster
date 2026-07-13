export function redactSensitiveText(text: string): string {
  return text
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|token|secret)\s*[=:]\s*)[^\s]+/gi, '$1[REDACTED]');
}
