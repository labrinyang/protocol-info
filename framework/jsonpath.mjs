// Tiny JSONPath dialect for workflow commands.
// Supported: a.b[0].c
// Not supported: filters, wildcards, recursive descent, quoted keys, slices.

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*/;

export function parse(path) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('jsonpath must be a non-empty string');
  }

  const segments = [];
  let i = 0;
  let expectSegment = true;

  while (i < path.length) {
    if (expectSegment) {
      const match = path.slice(i).match(IDENT);
      if (!match) {
        throw new Error(`invalid jsonpath at offset ${i}: expected identifier`);
      }
      segments.push(match[0]);
      i += match[0].length;
      expectSegment = false;
      continue;
    }

    const ch = path[i];
    if (ch === '.') {
      i += 1;
      expectSegment = true;
      if (i >= path.length) {
        throw new Error('invalid jsonpath: trailing dot');
      }
      continue;
    }

    if (ch === '[') {
      const close = path.indexOf(']', i + 1);
      if (close === -1) {
        throw new Error(`invalid jsonpath at offset ${i}: missing ]`);
      }
      const raw = path.slice(i + 1, close);
      if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
        throw new Error(`invalid jsonpath index "${raw}"`);
      }
      segments.push(Number(raw));
      i = close + 1;
      continue;
    }

    throw new Error(`invalid jsonpath at offset ${i}: unexpected "${ch}"`);
  }

  if (expectSegment) {
    throw new Error('invalid jsonpath: expected identifier');
  }
  return segments;
}

export function getAt(obj, path) {
  const segments = Array.isArray(path) ? path : parse(path);
  let cur = obj;
  for (const seg of segments) {
    if (typeof seg === 'number') {
      if (!Array.isArray(cur) || seg >= cur.length) {
        throw new Error(`jsonpath not found: ${format(segments)}`);
      }
      cur = cur[seg];
    } else {
      if (!cur || typeof cur !== 'object' || Array.isArray(cur) || !(seg in cur)) {
        throw new Error(`jsonpath not found: ${format(segments)}`);
      }
      cur = cur[seg];
    }
  }
  return cur;
}

export function setAt(obj, path, value) {
  const segments = Array.isArray(path) ? path : parse(path);
  if (segments.length === 0) {
    throw new Error('jsonpath must contain at least one segment');
  }

  let cur = obj;
  for (const seg of segments.slice(0, -1)) {
    if (typeof seg === 'number') {
      if (!Array.isArray(cur) || seg >= cur.length) {
        throw new Error(`jsonpath parent not found: ${format(segments)}`);
      }
      cur = cur[seg];
    } else {
      if (!cur || typeof cur !== 'object' || Array.isArray(cur) || !(seg in cur)) {
        throw new Error(`jsonpath parent not found: ${format(segments)}`);
      }
      cur = cur[seg];
    }
  }

  const last = segments[segments.length - 1];
  if (typeof last === 'number') {
    if (!Array.isArray(cur) || last >= cur.length) {
      throw new Error(`jsonpath array index out of range: ${format(segments)}`);
    }
    cur[last] = value;
  } else {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) {
      throw new Error(`jsonpath parent is not an object: ${format(segments)}`);
    }
    cur[last] = value;
  }
  return obj;
}

function format(segments) {
  let out = '';
  for (const seg of segments) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out ? `.${seg}` : seg;
  }
  return out;
}
