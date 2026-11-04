/** Bearer / X-API-Key gate for the translation endpoints. */

import { unauthorized } from "./errors.js";

export class ApiKeyGuard {
  constructor(private readonly expected: string | null) {}

  get enabled(): boolean {
    return Boolean(this.expected);
  }

  verify(request: Request): void {
    if (!this.expected) return;

    const token = bearer(request.headers.get("authorization")) ?? request.headers.get("x-api-key")?.trim();
    if (!token) {
      throw unauthorized("Missing credentials. Send 'Authorization: Bearer <token>' or 'X-API-Key'.");
    }
    if (!timingSafeEqual(token, this.expected)) throw unauthorized("Invalid API token.");
  }
}

function bearer(header: string | null): string | null {
  if (!header) return null;
  const [scheme, ...rest] = header.split(" ");
  if ((scheme ?? "").toLowerCase() !== "bearer") return null;
  return rest.join(" ").trim() || null;
}

function timingSafeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let diff = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return diff === 0;
}
