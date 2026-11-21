// @ts-check

/**
 * @param {unknown} body
 * @param {number} [status]
 */
export const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' },
  });

/** @param {string} message */
export const bad = (message) => json({ error: 'bad_request', message }, 400);

/**
 * @param {string} source
 * @param {any} err
 */
export const upstream = (source, err) =>
  json({ error: 'upstream_failure', source, message: err?.message ?? String(err) }, 502);

/** @param {Env} env */
export function appVersion(env) {
  const meta = /** @type {WorkerVersionMetadata | undefined} */ (env.CF_VERSION_METADATA);
  return meta?.tag || meta?.id || 'dev';
}

/**
 * @param {Response} response
 * @param {Record<string, string>} headers
 */
export function withHeaders(response, headers) {
  const copy = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) copy.headers.set(name, value);
  return copy;
}
