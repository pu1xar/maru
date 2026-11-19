// Client end of the session host protocol (protocol.ts): numbered requests with their replies, and
// events. The web server (claude/hostLink.ts) and the drain command (drain.ts) both use it.
import type { Duplex } from "node:stream";
import { encodeFrame, frameDecoder, type ErrorCode, type HostEvent, type HostFrame, type Request } from "./protocol.ts";

/** A request without its id; the client numbers it. */
export type RequestBody = Request extends infer R ? (R extends unknown ? Omit<R, "id"> : never) : never;

/** The host refused or failed a request. */
export class HostRequestError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "HostRequestError";
    this.code = code;
  }
}

/** The connection closed before the reply came. */
export class HostConnectionClosed extends Error {
  constructor() {
    super("the session host connection closed");
    this.name = "HostConnectionClosed";
  }
}

export interface HostClient {
  request<T = unknown>(req: RequestBody): Promise<T>;
  /** Sends without waiting for the reply. False when the connection is closed. */
  post(req: RequestBody): boolean;
  close(): void;
  readonly closed: boolean;
}

export function openHostClient(
  stream: Duplex,
  handlers: { onEvent(e: HostEvent): void; onClose(error: Error | null): void },
): HostClient {
  let nextId = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let closed = false;
  let error: Error | null = null;
  stream.on(
    "data",
    frameDecoder((f) => {
      const frame = f as HostFrame;
      if ("ev" in frame) {
        handlers.onEvent(frame);
        return;
      }
      if (typeof frame.id !== "number") return;
      const p = pending.get(frame.id);
      if (!p) return;
      pending.delete(frame.id);
      if (frame.ok) p.resolve(frame.result);
      else p.reject(new HostRequestError(frame.code, frame.error));
    }),
  );
  stream.on("error", (e) => {
    error = e;
  });
  stream.on("close", () => {
    closed = true;
    for (const p of pending.values()) p.reject(new HostConnectionClosed());
    pending.clear();
    handlers.onClose(error);
  });
  const write = (req: RequestBody, id: number) => stream.write(encodeFrame({ ...req, id }));
  return {
    request<T>(req: RequestBody): Promise<T> {
      if (closed) return Promise.reject(new HostConnectionClosed());
      const id = ++nextId;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        write(req, id);
      });
    },
    post(req: RequestBody): boolean {
      if (closed) return false;
      write(req, ++nextId);
      return true;
    },
    close(): void {
      stream.destroy();
    },
    get closed() {
      return closed;
    },
  };
}
