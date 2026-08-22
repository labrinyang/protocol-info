import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

const DEFAULT_MAX_REDIRECTS = 5;
const SENSITIVE_REDIRECT_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'x-api-key',
]);

function normalizedHostname(hostname) {
  return String(hostname || '')
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
}

function ipv4Parts(address) {
  if (isIP(address) !== 4) return null;
  const parts = address.split('.').map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
}

function isPublicIpv4(address) {
  const parts = ipv4Parts(address);
  if (!parts) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false;
  return true;
}

function expandedIpv6(address) {
  const normalized = normalizedHostname(address).split('%')[0];
  if (isIP(normalized) !== 6) return null;

  let input = normalized;
  const ipv4Tail = input.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (ipv4Tail) {
    const parts = ipv4Parts(ipv4Tail);
    if (!parts) return null;
    const high = ((parts[0] << 8) | parts[1]).toString(16);
    const low = ((parts[2] << 8) | parts[3]).toString(16);
    input = input.slice(0, -ipv4Tail.length) + `${high}:${low}`;
  }

  const sides = input.split('::');
  if (sides.length > 2) return null;
  const left = sides[0] ? sides[0].split(':') : [];
  const right = sides[1] ? sides[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (sides.length === 1 && missing !== 0)) return null;
  const words = [...left, ...Array(missing).fill('0'), ...right]
    .map((word) => Number.parseInt(word || '0', 16));
  return words.length === 8 && words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff)
    ? words
    : null;
}

function isPublicIpv6(address) {
  const words = expandedIpv6(address);
  if (!words) return false;
  if (words.every((word) => word === 0)) return false; // ::
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return false; // ::1
  if ((words[0] & 0xfe00) === 0xfc00) return false; // fc00::/7
  if ((words[0] & 0xffc0) === 0xfe80) return false; // fe80::/10
  if ((words[0] & 0xff00) === 0xff00) return false; // multicast
  if (words[0] === 0x2001 && words[1] === 0x0db8) return false; // documentation

  const mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  if (mapped) {
    const ipv4 = `${words[6] >> 8}.${words[6] & 0xff}.${words[7] >> 8}.${words[7] & 0xff}`;
    return isPublicIpv4(ipv4);
  }
  if ((words[0] & 0xe000) !== 0x2000) return false; // outside global unicast 2000::/3
  if (words[0] === 0x2001 && words[1] < 0x0200) return false; // IETF special-purpose space
  if (words[0] === 0x2002) return false; // 6to4 embeds an arbitrary IPv4 destination
  return true;
}

export function isPublicNetworkAddress(address) {
  const version = isIP(normalizedHostname(address));
  if (version === 4) return isPublicIpv4(normalizedHostname(address));
  if (version === 6) return isPublicIpv6(normalizedHostname(address));
  return false;
}

function defaultResolver(hostname) {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

function addressesFromLookup(result) {
  const values = Array.isArray(result) ? result : [result];
  return values
    .map((entry) => typeof entry === 'string' ? entry : entry?.address)
    .filter(Boolean);
}

function resolvedAddressEntries(result) {
  return addressesFromLookup(result).map((address) => ({
    address,
    family: isIP(normalizedHostname(address)),
  }));
}

async function validatePublicResourceUrl(value, {
  protocols = ['https:', 'http:'],
  resolveHostname = defaultResolver,
  signal = null,
} = {}) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('invalid resource URL');
  }
  if (!protocols.includes(parsed.protocol)) {
    throw new Error(`resource URL protocol is not allowed: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('resource URL credentials are not allowed');
  }

  const hostname = normalizedHostname(parsed.hostname);
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error(`resource URL host is not public: ${hostname || '<empty>'}`);
  }

  if (isIP(hostname)) {
    if (!isPublicNetworkAddress(hostname)) {
      throw new Error(`resource URL resolves to a non-public address: ${hostname}`);
    }
    return { parsed, addresses: [{ address: hostname, family: isIP(hostname) }] };
  }

  let addresses = null;
  if (typeof resolveHostname === 'function') {
    try {
      const lookup = Promise.resolve().then(() => resolveHostname(hostname));
      addresses = resolvedAddressEntries(await operationBeforeAbort(lookup, signal));
    } catch (err) {
      throw new Error(`resource URL host lookup failed: ${err.message}`);
    }
    if (addresses.length === 0) throw new Error('resource URL host lookup returned no addresses');
    const blocked = addresses.find(({ address, family }) => family === 0 || !isPublicNetworkAddress(address));
    if (blocked) throw new Error(`resource URL resolves to a non-public address: ${blocked.address}`);
  }
  return { parsed, addresses };
}

export async function assertPublicResourceUrl(value, {
  protocols = ['https:', 'http:'],
  resolveHostname = defaultResolver,
  signal = null,
} = {}) {
  return (await validatePublicResourceUrl(value, { protocols, resolveHostname, signal })).parsed;
}

function headerValue(headers, name) {
  return headers?.get?.(name) || null;
}

function headersWithoutCredentials(headers) {
  if (!headers) return headers;
  const entries = typeof headers.entries === 'function'
    ? [...headers.entries()]
    : Array.isArray(headers)
      ? headers
      : Object.entries(headers);
  return Object.fromEntries(entries.filter(([name]) => !SENSITIVE_REDIRECT_HEADERS.has(String(name).toLowerCase())));
}

function responseHeaders(headers) {
  return {
    get(name) {
      const value = headers?.[String(name).toLowerCase()];
      if (Array.isArray(value)) return value.join(', ');
      return value == null ? null : String(value);
    },
  };
}

function fetchPinnedResource(parsed, addresses, requestInit) {
  const method = String(requestInit.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    throw new Error(`resource request method is not allowed: ${method}`);
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new Error('resource request has no validated destination address');
  }

  const headers = requestInit.headers == null
    ? undefined
    : Object.fromEntries(new Headers(requestInit.headers).entries());
  const lookup = (_hostname, options, callback) => {
    if (typeof options === 'object' && options?.all) {
      callback(null, addresses);
      return;
    }
    callback(null, addresses[0].address, addresses[0].family);
  };
  const request = parsed.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise((resolvePromise, rejectPromise) => {
    const req = request(parsed, {
      method,
      headers,
      lookup,
      signal: requestInit.signal,
      ...(parsed.protocol === 'https:' && isIP(normalizedHostname(parsed.hostname)) === 0
        ? { servername: parsed.hostname }
        : {}),
    }, (incoming) => {
      const status = Number(incoming.statusCode || 0);
      resolvePromise({
        ok: status >= 200 && status < 300,
        status,
        headers: responseHeaders(incoming.headers),
        body: Readable.toWeb(incoming),
        url: parsed.toString(),
      });
    });
    req.on('error', rejectPromise);
    req.end();
  });
}

function resourceAbortError(signal, label = 'resource request') {
  if (signal?.reason instanceof Error) return signal.reason;
  if (signal?.reason != null) return new Error(String(signal.reason));
  return new Error(`${label} aborted`);
}

async function operationBeforeAbort(operationPromise, signal, { onLate = null } = {}) {
  const operation = Promise.resolve(operationPromise);
  if (!signal) return await operation;

  let aborted = signal.aborted;
  if (typeof onLate === 'function') {
    operation.then((value) => {
      if (aborted) onLate(value);
    }, () => {});
  }
  if (aborted) throw resourceAbortError(signal);

  let onAbort;
  const abort = new Promise((_, reject) => {
    onAbort = () => {
      aborted = true;
      reject(resourceAbortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([operation, abort]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

// Custom transports must set pinnedTransport and connect only to the
// validatedAddresses supplied in their request options.
export async function fetchPublicResource(value, {
  fetchImpl = globalThis.fetch,
  resolveHostname = fetchImpl === globalThis.fetch ? defaultResolver : null,
  pinnedTransport = fetchImpl === globalThis.fetch,
  protocols = ['https:', 'http:'],
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  requestInit = {},
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable');
  const customTransport = fetchImpl !== globalThis.fetch;
  if (customTransport && (typeof resolveHostname !== 'function' || pinnedTransport !== true)) {
    throw new Error('custom resource fetch requires an explicit resolver and pinned transport guarantee');
  }
  let current = String(value);
  let firstOrigin = null;

  for (let redirects = 0; ; redirects += 1) {
    const effectiveResolver = fetchImpl === globalThis.fetch
      ? (resolveHostname || defaultResolver)
      : resolveHostname;
    const { parsed, addresses } = await validatePublicResourceUrl(current, {
      protocols,
      resolveHostname: effectiveResolver,
      signal: requestInit.signal,
    });
    firstOrigin ??= parsed.origin;
    const crossOriginRedirect = redirects > 0 && parsed.origin !== firstOrigin;
    const effectiveInit = {
      ...requestInit,
      ...(crossOriginRedirect ? { headers: headersWithoutCredentials(requestInit.headers) } : {}),
      redirect: 'manual',
    };
    const responseOperation = Promise.resolve().then(() => !customTransport
      ? fetchPinnedResource(parsed, addresses, effectiveInit)
      : fetchImpl(parsed.toString(), { ...effectiveInit, validatedAddresses: addresses }));
    const response = await operationBeforeAbort(responseOperation, effectiveInit.signal, {
      onLate: (lateResponse) => {
        void cancelResponseBody(lateResponse, 'resource response arrived after abort');
      },
    });

    if (response?.url && response.url !== parsed.toString()) {
      try {
        await assertPublicResourceUrl(response.url, {
          protocols,
          resolveHostname: effectiveResolver,
          signal: requestInit.signal,
        });
      } catch (err) {
        await cancelResponseBody(response, 'resource response URL rejected');
        throw err;
      }
    }

    const status = Number(response?.status || 0);
    if (status < 300 || status > 399) {
      return { response, url: response?.url || parsed.toString(), redirects };
    }

    const location = headerValue(response.headers, 'location');
    if (!location) {
      await cancelResponseBody(response, 'redirect response missing Location');
      throw new Error(`redirect response ${status} has no Location header`);
    }
    if (redirects >= maxRedirects) {
      await cancelResponseBody(response, 'redirect limit exceeded');
      throw new Error(`too many redirects (>${maxRedirects})`);
    }
    try {
      current = new URL(location, parsed).toString();
    } catch {
      await cancelResponseBody(response, 'redirect Location rejected');
      throw new Error('redirect Location is invalid');
    }
    await cancelResponseBody(response, 'redirect response body not needed');
  }
}

export function responseContentType(response) {
  return String(headerValue(response?.headers, 'content-type') || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}

export async function cancelResponseBody(response, reason = 'response body rejected') {
  try {
    const cancellation = response?.body?.cancel?.(reason);
    Promise.resolve(cancellation).catch(() => {});
  } catch {
    // Best effort: callers are already rejecting the response.
  }
}

export async function readBoundedResponse(response, {
  maxBytes,
  label = 'resource',
  signal = null,
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('maxBytes must be a positive safe integer');
  }
  const rawLength = headerValue(response?.headers, 'content-length');
  const declaredLength = rawLength == null || rawLength === '' ? null : Number(rawLength);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await cancelResponseBody(response, `${label} exceeds ${maxBytes} bytes`);
    throw new Error(`${label} too large (${declaredLength} bytes; max ${maxBytes})`);
  }

  if (signal?.aborted) {
    await cancelResponseBody(response, `${label} read aborted`);
    throw resourceAbortError(signal, `${label} read`);
  }

  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    let onAbort = null;
    let abort = null;
    if (signal) {
      abort = new Promise((_, reject) => {
        onAbort = () => reject(resourceAbortError(signal, `${label} read`));
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    }
    try {
      while (true) {
        const read = reader.read();
        const { done, value } = abort ? await Promise.race([read, abort]) : await read;
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (total > maxBytes) {
          throw new Error(`${label} too large (more than ${maxBytes} bytes)`);
        }
        chunks.push(chunk);
      }
    } catch (err) {
      try {
        const cancellation = reader.cancel?.(err?.message || `${label} body rejected`);
        Promise.resolve(cancellation).catch(() => {});
      } catch {
        // Preserve the read or size-limit failure.
      }
      throw err;
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
      try {
        reader.releaseLock?.();
      } catch {
        // A transport that ignores cancellation may keep a read pending.
      }
    }
    return Buffer.concat(chunks, total);
  }

  throw new Error(`${label} response has no streaming body`);
}
