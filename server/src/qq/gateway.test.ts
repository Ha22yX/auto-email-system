import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { QqGateway, type QqGatewaySocket, type QqGatewayTimers } from "./gateway";
import type { QqGatewayState } from "../types";

type TimerTask = { at: number; callback: () => void };

class FakeClock implements QqGatewayTimers {
  now = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, TimerTask>();

  setTimeout(callback: () => void, delayMs: number) {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.now + delayMs, callback });
    return id;
  }

  clearTimeout(id: unknown) {
    this.tasks.delete(Number(id));
  }

  advance(delayMs: number) {
    const target = this.now + delayMs;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) break;
      this.tasks.delete(next[0]);
      this.now = next[1].at;
      next[1].callback();
    }
    this.now = target;
  }

  get pendingCount() {
    return this.tasks.size;
  }
}

class FakeSocket extends EventEmitter implements QqGatewaySocket {
  readonly sent: Array<Record<string, unknown>> = [];
  readyState = 1;
  closeCalls = 0;

  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close() {
    this.closeCalls += 1;
    this.readyState = 3;
    this.emit("close", 1000);
  }

  serverSend(frame: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(frame)));
  }

  serverClose(code = 1006) {
    this.readyState = 3;
    this.emit("close", code);
  }
}

function createHarness(options: {
  state?: QqGatewayState;
  tokenError?: Error;
  random?: () => number;
  reconnectMaxMs?: number;
} = {}) {
  const clock = new FakeClock();
  const sockets: FakeSocket[] = [];
  const writes: Array<Omit<QqGatewayState, "updatedAt">> = [];
  const statuses: unknown[] = [];
  let state = options.state;
  let tokenCalls = 0;
  const gateway = new QqGateway({
    tokenProvider: {
      async getToken() {
        tokenCalls += 1;
        if (options.tokenError) throw options.tokenError;
        return "fake-access-token";
      },
      invalidate() {}
    },
    webSocketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    readState: () => state,
    updateState: (next) => {
      writes.push({ ...next });
      state = { ...next, updatedAt: new Date(clock.now).toISOString() };
      return state;
    },
    timers: clock,
    now: () => clock.now,
    random: options.random ?? (() => 0.5),
    reconnectBaseMs: 100,
    reconnectMaxMs: options.reconnectMaxMs ?? 400,
    onStatus: (status) => statuses.push(status)
  });

  return { clock, gateway, sockets, statuses, writes, get tokenCalls() { return tokenCalls; } };
}

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
}

test("Hello identifies with the official QQBot token and only GROUP_AND_C2C_EVENT", async (t) => {
  const harness = createHarness();
  t.after(() => harness.gateway.stop());

  await harness.gateway.start();
  await harness.gateway.start();
  assert.equal(harness.sockets.length, 1);

  harness.sockets[0].serverSend({ op: 10, d: { heartbeat_interval: 50 } });
  assert.deepEqual(harness.sockets[0].sent[0], {
    op: 2,
    d: {
      token: "QQBot fake-access-token",
      intents: 1 << 25,
      shard: [0, 1],
      properties: { $os: process.platform, $browser: "auto-email-system", $device: "auto-email-system" }
    }
  });
  assert.equal(harness.gateway.status().state, "identifying");
});

test("heartbeats use the latest valid dispatch sequence and ACKs update status", async (t) => {
  const harness = createHarness();
  const dispatches: unknown[] = [];
  const unsubscribe = harness.gateway.onDispatch((event) => dispatches.push(event));
  t.after(async () => {
    unsubscribe();
    await harness.gateway.stop();
  });

  await harness.gateway.start();
  const socket = harness.sockets[0];
  socket.serverSend({ op: 10, d: { heartbeat_interval: 50 } });
  socket.serverSend({ op: 0, s: 7, t: "READY", id: "event-ready", d: { session_id: "session-1" } });
  socket.serverSend({ op: 0, s: "bad", t: "C2C_MESSAGE_CREATE", d: { id: "must-not-persist" } });

  assert.deepEqual(harness.writes, [{ sessionId: "session-1", sequence: 7, connectedAt: new Date(0).toISOString() }]);
  assert.deepEqual(dispatches, [
    { id: "event-ready", type: "READY", sequence: 7, data: { session_id: "session-1" } }
  ]);

  harness.clock.advance(50);
  assert.deepEqual(socket.sent.at(-1), { op: 1, d: 7 });
  harness.clock.advance(25);
  socket.serverSend({ op: 11, d: null });
  assert.equal(harness.gateway.status().lastHeartbeatAckAt, new Date(75).toISOString());
  harness.clock.advance(25);
  assert.deepEqual(socket.sent.at(-1), { op: 1, d: 7 });
});

test("a missing heartbeat ACK closes the socket and reconnects for Resume", async (t) => {
  const harness = createHarness();
  t.after(() => harness.gateway.stop());

  await harness.gateway.start();
  const first = harness.sockets[0];
  first.serverSend({ op: 10, d: { heartbeat_interval: 50 } });
  first.serverSend({ op: 0, s: 9, t: "READY", d: { session_id: "session-9" } });
  harness.clock.advance(100);

  assert.equal(first.closeCalls, 1);
  assert.equal(harness.gateway.status().state, "reconnecting");
  harness.clock.advance(100);
  await flushAsync();
  assert.equal(harness.sockets.length, 2);
  harness.sockets[1].serverSend({ op: 10, d: { heartbeat_interval: 50 } });
  assert.deepEqual(harness.sockets[1].sent[0], {
    op: 6,
    d: { token: "QQBot fake-access-token", session_id: "session-9", seq: 9 }
  });
});

test("persisted sessions Resume and invalid sessions clear state before Identify", async (t) => {
  const harness = createHarness({
    state: { sessionId: "persisted-session", sequence: 21, updatedAt: "2026-08-16T00:00:00.000Z" }
  });
  t.after(() => harness.gateway.stop());

  await harness.gateway.start();
  const socket = harness.sockets[0];
  socket.serverSend({ op: 10, d: { heartbeat_interval: 100 } });
  assert.deepEqual(socket.sent[0], {
    op: 6,
    d: { token: "QQBot fake-access-token", session_id: "persisted-session", seq: 21 }
  });

  socket.serverSend({ op: 9, d: false });
  assert.deepEqual(harness.writes, [{}]);
  assert.equal(socket.sent[1].op, 2);
  assert.equal((socket.sent[1].d as Record<string, unknown>).token, "QQBot fake-access-token");
  assert.equal(harness.gateway.status().state, "identifying");
});

test("server reconnect requests replace one socket after backoff without parallel ownership", async (t) => {
  const harness = createHarness();
  t.after(() => harness.gateway.stop());

  await harness.gateway.start();
  const first = harness.sockets[0];
  first.serverSend({ op: 7, d: null });
  first.serverSend({ op: 7, d: null });
  assert.equal(first.closeCalls, 1);
  assert.equal(harness.sockets.length, 1);

  harness.clock.advance(99);
  assert.equal(harness.sockets.length, 1);
  harness.clock.advance(1);
  await flushAsync();
  assert.equal(harness.sockets.length, 2);
  assert.equal(harness.sockets.filter((socket) => socket.readyState !== 3).length, 1);
});

test("a stale token request cannot create a socket after stop and restart", async () => {
  const clock = new FakeClock();
  const sockets: FakeSocket[] = [];
  const tokenResolvers: Array<(token: string) => void> = [];
  const gateway = new QqGateway({
    tokenProvider: {
      getToken: () =>
        new Promise<string>((resolve) => {
          tokenResolvers.push(resolve);
        }),
      invalidate() {}
    },
    webSocketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    readState: () => undefined,
    updateState: (state) => ({ ...state, updatedAt: new Date(clock.now).toISOString() }),
    timers: clock
  });

  const firstStart = gateway.start();
  await flushAsync();
  assert.equal(tokenResolvers.length, 1);
  await gateway.stop();

  const secondStart = gateway.start();
  await flushAsync();
  assert.equal(tokenResolvers.length, 2);

  tokenResolvers[0]("stale-token");
  await firstStart;
  await flushAsync();
  assert.equal(sockets.length, 0);

  tokenResolvers[1]("fresh-token");
  await secondStart;
  assert.equal(sockets.length, 1);
  await gateway.stop();
});

test("reconnect failures back off exponentially and stop cancels all pending work", async () => {
  const secret = "super-secret-access-token";
  const harness = createHarness({ tokenError: new Error(secret) });

  await harness.gateway.start();
  assert.equal(harness.gateway.status().state, "reconnecting");
  assert.equal(JSON.stringify(harness.statuses).includes(secret), false);
  assert.equal(harness.clock.pendingCount, 1);

  harness.clock.advance(100);
  await flushAsync();
  assert.equal(harness.tokenCalls, 2);
  harness.clock.advance(199);
  assert.equal(harness.tokenCalls, 2);
  harness.clock.advance(1);
  await flushAsync();
  assert.equal(harness.tokenCalls, 3);

  await harness.gateway.stop();
  assert.equal(harness.clock.pendingCount, 0);
  assert.equal(harness.gateway.status().state, "stopped");
  harness.clock.advance(1_000);
  await flushAsync();
  assert.equal(harness.tokenCalls, 3);
  assert.equal(harness.sockets.length, 0);
});

test("reconnect jitter never exceeds the configured maximum delay", async () => {
  const harness = createHarness({
    tokenError: new Error("transient"),
    random: () => 1,
    reconnectMaxMs: 150
  });

  await harness.gateway.start();
  assert.equal(harness.tokenCalls, 1);

  harness.clock.advance(125);
  await flushAsync();
  assert.equal(harness.tokenCalls, 2);

  harness.clock.advance(150);
  await flushAsync();
  assert.equal(harness.tokenCalls, 3);

  await harness.gateway.stop();
});

test("stop closes the owned socket and cancels heartbeat plus reconnect timers", async () => {
  const harness = createHarness();
  await harness.gateway.start();
  const socket = harness.sockets[0];
  socket.serverSend({ op: 10, d: { heartbeat_interval: 50 } });
  assert.equal(harness.clock.pendingCount, 1);

  await harness.gateway.stop();
  assert.equal(socket.closeCalls, 1);
  assert.equal(harness.clock.pendingCount, 0);
  harness.clock.advance(500);
  await flushAsync();
  assert.equal(harness.sockets.length, 1);
});
