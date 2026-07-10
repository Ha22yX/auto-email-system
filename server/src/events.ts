import type express from "express";

type AppEvent = {
  type: string;
  payload: unknown;
  at: string;
};

const clients = new Set<express.Response>();

export function publishAppEvent(type: string, payload: unknown = {}) {
  const event: AppEvent = {
    type,
    payload,
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
