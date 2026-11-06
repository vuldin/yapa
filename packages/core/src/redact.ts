/** Redact anything that looks like a JWT from text that may be shown or logged. */
export function redactTokens(text: string): string {
  return text.replace(/[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(\.[A-Za-z0-9_-]*)?/g, '<token>');
}
