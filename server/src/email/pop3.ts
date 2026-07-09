import net from "node:net";
import tls from "node:tls";
import { hasProcessed } from "../store";
import type { IncomingEmail, Mailbox } from "../types";
import { parseIncomingEmail } from "./parse";

type Socket = net.Socket | tls.TLSSocket;

type PopMessageRef = {
  index: number;
  uid: string;
};

class Pop3Client {
  private socket?: Socket;
  private buffer = "";
  private waiters: Array<(line: string) => void> = [];

  constructor(private mailbox: Mailbox) {}

  async connect() {
    this.socket = this.mailbox.secure
      ? tls.connect({ host: this.mailbox.host, port: this.mailbox.port, servername: this.mailbox.host })
      : net.connect({ host: this.mailbox.host, port: this.mailbox.port });

    this.socket.setTimeout(30000);
    this.socket.on("data", (chunk) => this.onData(chunk.toString("utf8")));
    this.socket.on("timeout", () => this.socket?.destroy(new Error("POP3 连接超时")));

    await this.expectOkLine();
    await this.command(`USER ${this.mailbox.username}`);
    await this.command(`PASS ${this.mailbox.password}`);
  }

  async listUidl() {
    const lines = await this.commandMulti("UIDL");
    return lines
      .map((line): PopMessageRef | undefined => {
        const [index, uid] = line.trim().split(/\s+/, 2);
        const messageIndex = Number(index);
        if (!Number.isFinite(messageIndex) || !uid) return undefined;
        return { index: messageIndex, uid };
      })
      .filter((item): item is PopMessageRef => Boolean(item));
  }

  async retrieve(index: number) {
    const lines = await this.commandMulti(`RETR ${index}`);
    return lines.join("\r\n");
  }

  async quit() {
    try {
      await this.command("QUIT");
    } finally {
      this.socket?.end();
    }
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let lineEnd = this.buffer.indexOf("\r\n");
    while (lineEnd >= 0) {
      const line = this.buffer.slice(0, lineEnd);
      this.buffer = this.buffer.slice(lineEnd + 2);
      const waiter = this.waiters.shift();
      if (waiter) waiter(line);
      lineEnd = this.buffer.indexOf("\r\n");
    }
  }

  private readLine() {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("POP3 响应超时")), 30000);
      this.waiters.push((line) => {
        clearTimeout(timer);
        resolve(line);
      });
    });
  }

  private write(command: string) {
    this.socket?.write(`${command}\r\n`);
  }

  private async expectOkLine() {
    const line = await this.readLine();
    if (!line.startsWith("+OK")) {
      throw new Error(`POP3 返回错误: ${line}`);
    }
    return line;
  }

  private async command(command: string) {
    this.write(command);
    return this.expectOkLine();
  }

  private async commandMulti(command: string) {
    await this.command(command);
    const lines: string[] = [];

    while (true) {
      const line = await this.readLine();
      if (line === ".") break;
      lines.push(line.startsWith("..") ? line.slice(1) : line);
    }

    return lines;
  }
}

export type FetchedPopEmail = {
  email: IncomingEmail;
  markRead: () => Promise<{ marked: boolean; note?: string }>;
};

export async function fetchUnreadPop3(mailbox: Mailbox, limit: number): Promise<FetchedPopEmail[]> {
  const client = new Pop3Client(mailbox);
  const results: FetchedPopEmail[] = [];

  await client.connect();
  try {
    const refs = await client.listUidl();
    const candidates = refs.filter((ref) => !hasProcessed(mailbox.id, ref.uid)).slice(0, limit);

    for (const ref of candidates) {
      const rawSource = await client.retrieve(ref.index);
      const email = await parseIncomingEmail({
        mailboxId: mailbox.id,
        externalUid: ref.uid,
        rawSource
      });

      results.push({
        email,
        markRead: async () => ({
          marked: false,
          note: "POP3 不支持标准已读标记，系统已在本地记录为已处理。"
        })
      });
    }
  } finally {
    await client.quit();
  }

  return results;
}
