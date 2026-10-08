import { ReservationHistoryError, validHistoryPosition,
  type ReservationHistoryCursorCodec, type ReservationHistoryPosition } from "../application/reservation-history";

function base64url(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decodeBase64url(value: string): Uint8Array {
  const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
  if (base64url(bytes) !== value) throw new Error();
  return bytes;
}
export function validHistoryCursorGrammar(cursor: string): boolean {
  return /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.exec(cursor)?.[0] === cursor;
}
// Server-only key injection. No env/query lookup, provisioning, logs or default key.
export class HmacReservationHistoryCursorCodec implements ReservationHistoryCursorCodec {
  readonly #key: CryptoKey;
  constructor(key: CryptoKey) { this.#key = key; }

  private async tag(studentId: string, payload: string): Promise<Uint8Array> {
    try {
      if (this.#key.type !== "secret" || this.#key.algorithm.name !== "HMAC" ||
          (this.#key.algorithm as HmacKeyAlgorithm).hash.name !== "SHA-256") throw new Error();
      return new Uint8Array(await crypto.subtle.sign("HMAC", this.#key,
        new TextEncoder().encode(JSON.stringify(["reservation-history-v1", studentId, payload]))));
    } catch { throw new ReservationHistoryError("SERVICE_UNAVAILABLE"); }
  }
  async encode(studentId: string, position: ReservationHistoryPosition): Promise<string> {
    if (!studentId || !validHistoryPosition(position)) throw new ReservationHistoryError("INTEGRITY_STATE_UNAVAILABLE");
    const payload = base64url(new TextEncoder().encode(JSON.stringify({
      version: 1, startsAt: position.startsAt, reservationId: position.reservationId,
    })));
    return `v1.${payload}.${base64url(await this.tag(studentId, payload))}`;
  }
  async decode(studentId: string, cursor: string): Promise<ReservationHistoryPosition> {
    const invalid = () => new ReservationHistoryError("INVALID_REQUEST");
    if (!studentId || !validHistoryCursorGrammar(cursor)) throw invalid();
    const [, payload, signature] = cursor.split(".");
    let bytes: Uint8Array, supplied: Uint8Array;
    try { bytes = decodeBase64url(payload); supplied = decodeBase64url(signature); } catch { throw invalid(); }
    const expected = await this.tag(studentId, payload);
    let mismatch = supplied.length ^ expected.length;
    for (let i = 0; i < expected.length; i++) mismatch |= expected[i] ^ (supplied[i] ?? 0);
    if (mismatch !== 0) throw invalid();
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const value = JSON.parse(text);
      if (!value || value.version !== 1 || !validHistoryPosition(value) ||
          text !== JSON.stringify({ version: 1, startsAt: value.startsAt, reservationId: value.reservationId })) throw invalid();
      return { startsAt: value.startsAt, reservationId: value.reservationId };
    } catch { throw invalid(); }
  }
}
