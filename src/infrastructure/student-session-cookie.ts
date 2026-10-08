// Shared #842 / #865 HTTP-infrastructure parser; raw token stays transient.
export function isCanonicalToken(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const bytes = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=");
  return bytes.length === 32 && btoa(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") === value;
}

export function studentSessionToken(request: Request): string | null {
  const matches = (request.headers.get("cookie") ?? "").split(";")
    .map((part) => part.trim())
    .filter((part) => part.split("=", 1)[0] === "__Host-student_session");
  if (matches.length !== 1) return null;
  const token = matches[0].slice("__Host-student_session=".length);
  return matches[0] === `__Host-student_session=${token}` && isCanonicalToken(token) ? token : null;
}
