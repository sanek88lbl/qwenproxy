import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { config } from '../core/config.js';

export class AttachmentDownloadError extends Error {
  constructor(message: string, public upstreamStatus = 400, public code = 'attachment_download_failed') { super(message); }
}

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['2000::', 16], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3ffe::', 16], ['3fff::', 20],
] as const) blocked.addSubnet(address, prefix, 'ipv6');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

export function isPublicAttachmentAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4')
    : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

function parseUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new AttachmentDownloadError('Invalid attachment URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new AttachmentDownloadError('Attachment URL scheme or credentials are not allowed', 400, 'attachment_url_blocked');
  }
  return url;
}

async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); });
    if (signal.aborted) onAbort();
  });
}

export async function downloadAttachment(value: string, options: { signal?: AbortSignal; maxBytes?: number } = {}): Promise<{
  buffer: Buffer; contentType: string; url: URL;
}> {
  let url = parseUrl(value);
  const maxBytes = Math.min(config.attachmentDownload.maxBytes, options.maxBytes ?? config.attachmentDownload.maxBytes);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new AttachmentDownloadError('Invalid attachment byte limit');
  const controller = new AbortController();
  const cancelled = () => controller.abort(new AttachmentDownloadError('Attachment download cancelled', 400, 'attachment_cancelled'));
  options.signal?.addEventListener('abort', cancelled, { once: true });
  if (options.signal?.aborted) cancelled();
  const timeout = setTimeout(() => controller.abort(new AttachmentDownloadError('Attachment download timed out', 504, 'attachment_timeout')),
    config.attachmentDownload.timeoutMs);
  try {
    for (let redirects = 0; ; redirects++) {
      controller.signal.throwIfAborted();
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      const literalFamily = isIP(hostname);
      const addresses = literalFamily ? [{ address: hostname, family: literalFamily }]
        : await abortable(dns.lookup(hostname, { all: true, verbatim: true }), controller.signal);
      if (!addresses.length || addresses.some(entry => isIP(entry.address) !== entry.family || !isPublicAttachmentAddress(entry.address))) {
        throw new AttachmentDownloadError('Attachment URL targets a non-public address', 400, 'attachment_url_blocked');
      }
      controller.signal.throwIfAborted();
      const target = addresses[0];
      const pinned = new BlockList();
      for (const entry of addresses) pinned.addAddress(entry.address, entry.family === 4 ? 'ipv4' : 'ipv6');
      const lookup: LookupFunction = (_hostname, lookupOptions, callback) => {
        if (lookupOptions.all) callback(null, addresses);
        else callback(null, target.address, target.family);
      };
      const secure = url.protocol === 'https:';
      const agent = secure ? new https.Agent({ keepAlive: false, proxyEnv: {}, rejectUnauthorized: true }) : new http.Agent({ keepAlive: false, proxyEnv: {} });
      let request: http.ClientRequest | undefined;
      let closed = Promise.resolve();
      try {
        const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
          request = (secure ? https : http).request(url, {
            method: 'GET', agent, lookup, signal: controller.signal,
            headers: { Accept: '*/*', 'Accept-Encoding': 'identity', Connection: 'close' },
          }, resolve);
          closed = new Promise<void>(done => request!.once('close', done));
          request.once('error', reject);
          request.once('socket', socket => {
            const verify = () => {
              const address = socket.remoteAddress || '';
              const family = isIP(address);
              if (!family || !pinned.check(address, family === 4 ? 'ipv4' : 'ipv6')) {
                request!.destroy(new AttachmentDownloadError('Attachment connection address does not match its validated DNS address', 400, 'attachment_url_blocked'));
              }
            };
            if (socket.connecting) socket.prependOnceListener('connect', verify);
            else verify();
          });
          request.end();
        });
        const status = response.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          if (redirects >= config.attachmentDownload.maxRedirects || !response.headers.location) {
            throw new AttachmentDownloadError('Attachment redirect limit or invalid redirect', 502);
          }
          url = parseUrl(new URL(response.headers.location, url).href);
          continue;
        }
        if (status < 200 || status >= 300) throw new AttachmentDownloadError(`Attachment server returned HTTP ${status}`, 502);
        if (Number(response.headers['content-length'] || 0) > maxBytes) {
          throw new AttachmentDownloadError('Attachment exceeds the download byte limit', 413, 'attachment_too_large');
        }
        const encoding = (response.headers['content-encoding'] || 'identity').trim().toLowerCase();
        const decode = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate()
          : encoding === 'br' ? createBrotliDecompress() : undefined;
        if (!decode && encoding !== 'identity') throw new AttachmentDownloadError('Unsupported attachment content encoding', 502);
        let wireBytes = 0;
        let bodyBytes = 0;
        const chunks: Buffer[] = [];
        const wireLimit = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            wireBytes += chunk.length;
            callback(wireBytes > maxBytes ? new AttachmentDownloadError('Attachment exceeds the download byte limit', 413, 'attachment_too_large') : null, chunk);
          },
        });
        const sink = new Writable({
          write(chunk: Buffer, _encoding, callback) {
            bodyBytes += chunk.length;
            if (bodyBytes > maxBytes) callback(new AttachmentDownloadError('Attachment exceeds the download byte limit', 413, 'attachment_too_large'));
            else { chunks.push(Buffer.from(chunk)); callback(); }
          },
        });
        await pipeline([response, wireLimit, ...(decode ? [decode] : []), sink], { signal: controller.signal });
        return { buffer: Buffer.concat(chunks, bodyBytes), contentType: response.headers['content-type'] || '', url };
      } finally {
        request?.destroy();
        agent.destroy();
        await closed;
      }
    }
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof AttachmentDownloadError) throw error;
    throw new AttachmentDownloadError('Attachment download failed', 502);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', cancelled);
  }
}
