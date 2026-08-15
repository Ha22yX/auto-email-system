import type express from "express";

type AppEvent = {
  type: string;
  payload: unknown;
  at: string;
};

const clients = new Set<express.Response>();

const SENSITIVE_EVENT_KEY = /(?:secret|token|user_?openid|userOpenId|codeHash|salt)/i;

export function sanitizeAppEventPayload(value: unknown, depth = 0): unknown {
  if (depth > 6) return undefined;
  if (typeof value === "string") return value.slice(0, 1000);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeAppEventPayload(item, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !SENSITIVE_EVENT_KEY.test(key))
      .map(([key, item]) => [key, sanitizeAppEventPayload(item, depth + 1)])
  );
}
export function publishAppEvent(type: string, payload: unknown = {}) {
  const event: AppEvent = {
    type,
    payload: sanitizeAppEventPayload(payload),
    at: new Date().toISOString()
  };
  const data = `event: app\ndata: ${JSON.stringify(event)}\n\n`;

  for (const client of clients) {
    client.write(data);
  }
}

export function handleAppEvents(req: express.Request, res: express.Response) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  clients.add(res);
  res.write(`event: app\ndata: ${JSON.stringify({ type: "connected", payload: {}, at: new Date().toISOString() })}\n\n`);

  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
}
