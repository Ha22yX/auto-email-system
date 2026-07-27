import type express from "express";
import { currentUserId } from "./user-context";

type AppEvent = {
  type: string;
  payload: unknown;
  at: string;
};

const clients = new Map<string, Set<express.Response>>();

export function publishAppEvent(type: string, payload: unknown = {}) {
  const uid = currentUserId();
  const event: AppEvent = {
    type,
    payload,
    at: new Date().toISOString()
  };
  const data = `event: app\ndata: ${JSON.stringify(event)}\n\n`;

  for (const client of clients.get(uid) ?? []) {
    client.write(data);
  }
}

export function handleAppEvents(req: express.Request, res: express.Response) {
  const uid = currentUserId();
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const userClients = clients.get(uid) ?? new Set<express.Response>();
  userClients.add(res);
  clients.set(uid, userClients);
  res.write(`event: app\ndata: ${JSON.stringify({ type: "connected", payload: {}, at: new Date().toISOString() })}\n\n`);

  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    userClients.delete(res);
    if (!userClients.size) clients.delete(uid);
  });
}
