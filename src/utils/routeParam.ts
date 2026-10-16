/**
 * Express 5 types route params as `string | string[]`; normalize to a single
 * string so handlers can use `req.params.x` directly.
 */
export function routeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}
