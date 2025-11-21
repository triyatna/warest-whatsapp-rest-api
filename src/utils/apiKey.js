import crypto from "node:crypto";
import { ulid } from "ulid";

export function randomApiKeyLike(prefix = "replaced") {
  return `${prefix}_${ulid()}_${crypto.randomBytes(6).toString("hex")}`;
}

