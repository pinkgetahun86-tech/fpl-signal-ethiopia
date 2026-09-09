import type {
  TelegramApiEnvelope,
  TelegramInlineKeyboardMarkup,
} from "./types";

const telegramApiBase = "https://api.telegram.org/bot";

async function telegramRequest<T>(
  method: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN Secret is required to connect to Telegram.",
    );
  }

  const response = await fetch(`${telegramApiBase}${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

  const payload = (await response.json()) as TelegramApiEnvelope<T>;
  if (!response.ok || !payload.ok || payload.result === undefined) {
    throw new Error(payload.description ?? `Telegram ${method} failed`);
  }
  return payload.result;
}

export function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean> {
  return telegramRequest<boolean>("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
  });
}

export function sendMessage(
  chatId: string,
  text: string,
  replyMarkup?: TelegramInlineKeyboardMarkup,
): Promise<unknown> {
  return telegramRequest("sendMessage", {
    chat_id: chatId,
    text,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

export function getUpdates(offset?: number): Promise<import("./types").TelegramUpdate[]> {
  return telegramRequest("getUpdates", {
    timeout: 20,
    ...(offset === undefined ? {} : { offset }),
    allowed_updates: ["message", "callback_query"],
  });
}

export function setChatMenuButton(
  menuButton: { type: "default" } | { type: "web_app"; text: string; web_app: { url: string } },
): Promise<boolean> {
  return telegramRequest<boolean>("setChatMenuButton", { menu_button: menuButton });
}