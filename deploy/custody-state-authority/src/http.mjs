import { ApiError } from './errors.mjs';
import { sha256Hex } from './codec.mjs';

const MAX_BODY_BYTES = 200_000;

function header(event, name) {
  const wanted = name.toLowerCase();
  const entry = Object.entries(event?.headers || {}).find(([key]) => key.toLowerCase() === wanted);
  return entry?.[1];
}

function requestMethod(event) {
  return event?.requestContext?.http?.method || event?.httpMethod || '';
}

function rejectQuery(event) {
  const raw = event?.rawQueryString;
  const parameters = event?.queryStringParameters;
  if (
    (typeof raw === 'string' && raw.length > 0) ||
    (parameters && typeof parameters === 'object' && Object.keys(parameters).length > 0)
  ) {
    throw new ApiError(400, 'query_not_allowed', 'custody authority routes do not accept queries');
  }
}

function decodeBody(event) {
  if (typeof event?.body !== 'string') return null;
  let bytes;
  try {
    bytes = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
  } catch {
    throw new ApiError(400, 'invalid_json', 'request body encoding is invalid');
  }
  if (bytes.length > MAX_BODY_BYTES) {
    throw new ApiError(413, 'request_too_large', 'request body exceeds the local authority limit');
  }
  return bytes;
}

function parseBody(event) {
  const contentType = header(event, 'content-type') || '';
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new ApiError(415, 'unsupported_media_type', 'content-type must be application/json');
  }
  if (typeof event?.body !== 'string') {
    throw new ApiError(400, 'invalid_json', 'a JSON request body is required');
  }
  const bytes = decodeBody(event);
  const text = bytes.toString('utf8');
  if (text.includes('\uFFFD')) {
    throw new ApiError(400, 'invalid_json', 'request body is not valid UTF-8');
  }
  try {
    return { input: JSON.parse(text), bytes };
  } catch {
    throw new ApiError(400, 'invalid_json', 'request body is not valid JSON');
  }
}

function bodyless(event) {
  const bytes = decodeBody(event) || Buffer.alloc(0);
  if (bytes.length !== 0) {
    throw new ApiError(400, 'unexpected_body', 'this request must not carry a body');
  }
  return bytes;
}

function bearerToken(event) {
  const value = header(event, 'x-custody-session') || '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new ApiError(401, 'invalid_session', 'a valid x-custody-session token is required');
  }
  return value;
}

function requiredHeader(event, name) {
  const value = header(event, name);
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError(401, 'invalid_request_proof', 'complete request proof headers are required');
  }
  return value;
}

function routePath(route, pathParameters = {}) {
  if (typeof route !== 'string' || !route.startsWith('/v1/')) {
    throw new TypeError('a canonical v1 route is required for session authentication');
  }
  const expanded = route.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_match, name) => {
    const value = pathParameters?.[name];
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > 1024 ||
      /[/?#\p{Cc}]/u.test(value)
    ) {
      throw new ApiError(400, 'invalid_path', `path parameter ${name} is invalid`);
    }
    return value;
  });
  if (expanded.includes('{') || expanded.includes('}')) {
    throw new ApiError(400, 'invalid_path', 'required path parameters are absent');
  }
  return expanded;
}

function requestProof(event, method, route, bytes) {
  return {
    method,
    path: routePath(route, event?.pathParameters),
    bodySha256: sha256Hex(bytes),
    timestampMs: requiredHeader(event, 'x-custody-pop-timestamp'),
    nonceHex: requiredHeader(event, 'x-custody-pop-nonce'),
    signatureBase64: requiredHeader(event, 'x-custody-pop-signature'),
  };
}

function response(statusCode, body, requestId) {
  return {
    statusCode,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
    },
    body: JSON.stringify({ ...body, request_id: requestId || null }),
  };
}

export function makeHandler({ method, route, body = false, session = false, invoke }) {
  if (!method || typeof invoke !== 'function')
    throw new TypeError('method and invoke are required');
  if (session && !route) throw new TypeError('session handlers require their canonical route');
  return async (event, context = {}) => {
    const requestId = event?.requestContext?.requestId || context.awsRequestId || null;
    try {
      if (requestMethod(event) !== method) {
        throw new ApiError(405, 'method_not_allowed', `this function accepts only ${method}`);
      }
      rejectQuery(event);
      const parsed = body ? parseBody(event) : { input: undefined, bytes: bodyless(event) };
      const token = session ? bearerToken(event) : undefined;
      const result = await invoke({
        input: parsed.input,
        token,
        path: event?.pathParameters || {},
        proof: session ? requestProof(event, method, route, parsed.bytes) : undefined,
      });
      return response(result.statusCode, result.body, requestId);
    } catch (error) {
      if (error instanceof ApiError) {
        return response(
          error.statusCode,
          { error: { code: error.code, message: error.message } },
          requestId
        );
      }
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'custody_state_authority_failure',
          request_id: requestId,
          error_name: error?.name || 'Error',
          error_message: error?.message || 'unknown error',
        })
      );
      return response(
        500,
        { error: { code: 'internal_error', message: 'authority request failed closed' } },
        requestId
      );
    }
  };
}

export const __httpInternalsForTests = Object.freeze({
  parseBody,
  bearerToken,
  requestProof,
  routePath,
});
