import type { TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { Socket } from 'node:net';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';

export interface AttachmentHttpFixture {
  status?: number;
  headers?: http.IncomingHttpHeaders;
  chunks?: Uint8Array[];
  stall?: boolean;
  remoteAddress?: string;
}

const restorers = new WeakMap<TestContext, () => void>();

export function installAttachmentHttpFixture(t: TestContext, handler: (url: URL) => AttachmentHttpFixture,
  resolve: (hostname: string) => Promise<{ address: string; family: number }[]> = async () => [{ address: '8.8.8.8', family: 4 }]) {
  restorers.get(t)?.();
  const calls: { url: URL; options: http.RequestOptions; pinned: unknown; request: http.ClientRequest }[] = [];
  const dnsMock = t.mock.method(dns, 'lookup', resolve);
  const request = (url: URL, options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => {
    const fixture = handler(url);
    const response = new PassThrough() as unknown as http.IncomingMessage;
    const socket = new PassThrough() as unknown as Socket;
    Object.defineProperties(socket, {
      remoteAddress: { value: fixture.remoteAddress || '8.8.8.8' },
      connecting: { value: true, writable: true },
    });
    response.statusCode = fixture.status ?? 200;
    response.headers = fixture.headers ?? {};
    response.socket = socket;
    const emitter = new EventEmitter();
    const req = emitter as unknown as http.ClientRequest;
    const record = { url, options, pinned: undefined as unknown, request: req };
    calls.push(record);
    let destroyed = false;
    const onAbort = () => req.destroy(new Error('fixture request aborted'));
    Object.defineProperty(req, 'destroyed', { get: () => destroyed });
    req.destroy = (error?: Error) => {
      if (destroyed) return req;
      destroyed = true;
      options.signal?.removeEventListener('abort', onAbort);
      if (error) emitter.emit('error', error);
      response.destroy();
      socket.destroy();
      emitter.emit('close');
      return req;
    };
    req.end = (() => {
      queueMicrotask(() => {
        if (destroyed) return;
        options.lookup!(url.hostname, { all: true }, (error, address) => {
          if (error) { req.destroy(error); return; }
          record.pinned = address;
        });
        emitter.emit('socket', socket);
        Object.defineProperty(socket, 'connecting', { value: false, writable: true });
        socket.emit('connect');
        if (destroyed) return;
        callback(response);
        if (!fixture.stall) {
          for (const chunk of fixture.chunks ?? []) response.push(Buffer.from(chunk));
          response.push(null);
        }
      });
      return req;
    }) as http.ClientRequest['end'];
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) queueMicrotask(onAbort);
    return req;
  };
  const httpMock = t.mock.method(http, 'request', request);
  const httpsMock = t.mock.method(https, 'request', request);
  restorers.set(t, () => { dnsMock.mock.restore(); httpMock.mock.restore(); httpsMock.mock.restore(); });
  return calls;
}
