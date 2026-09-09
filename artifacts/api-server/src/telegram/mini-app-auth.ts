import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import type { TelegramUser } from "./types";

const MAX_INIT_DATA_AGE_SECONDS = 24 * 60 * 60;

export class MiniAppAuthError extends Error {
  readonly status = 401;

  constructor(message = "Telegram Mini App authentication is invalid") {
    super(message);
    this.name = "MiniAppAuthError";
  }
}

function getInitData(request: Request): string {
  const explicit = request.header("x-telegram-init-data")?.trim();
  if (explicit) return explicit;

  const authorization = request.header("authorization")?.trim();
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }

  throw new MiniAppAuthError("Telegram Mini App authentication is required");
}

function isValidHash(expected: string, received: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(received)) return false;
  const expectedBuffer = Buffer.from(expected, "hex");
  const receivedBuffer = Buffer.from(received, "hex");
  return (
    expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}

export function authenticateMiniAppRequest(request: Request): TelegramUser {
  const botToken = process.env["TELEGRAM_BOT_TOKEN"];
  if (!botToken) {
    throw new MiniAppAuthError("Telegram Mini App authentication is unavailable");
  }

  const rawInitData = getInitData(request);
  const params = new URLSearchParams(rawInitData);
  const receivedHash = params.get("hash");
  const authDate = Number(params.get("auth_date"));
  const userValue = params.get("user");
  if (!receivedHash || !Number.isInteger(authDate) || !userValue) {
    throw new MiniAppAuthError();
  }

  const age = Math.floor(Date.now() / 1000) - authDate;
  if (age < -60 || age > MAX_INIT_DATA_AGE_SECONDS) {
    throw new MiniAppAuthError("Telegram Mini App authentication has expired");
  }

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expectedHash = createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");
  if (!isValidHash(expectedHash, receivedHash)) {
    throw new MiniAppAuthError();
  }

  let user: unknown;
  try {
    user = JSON.parse(userValue);
  } catch {
    throw new MiniAppAuthError();
  }
  if (!user || typeof user !== "object") throw new MiniAppAuthError();

  const candidate = user as Record<string, unknown>;
  if (
    typeof candidate.id !== "number" ||
    !Number.isSafeInteger(candidate.id) ||
    candidate.id <= 0
  ) {
    throw new MiniAppAuthError();
  }

  return {
    id: candidate.id,
    first_name:
      typeof candidate.first_name === "string" ? candidate.first_name : undefined,
    last_name: typeof candidate.last_name === "string" ? candidate.last_name : undefined,
    username: typeof candidate.username === "string" ? candidate.username : undefined,
  };
}