import { RequestMethod, type ExecutionContext } from '@nestjs/common';
import 'reflect-metadata';

// Stable NestJS metadata keys (v10–v12). Their export path moved between
// majors (`@nestjs/common/constants` → `@nestjs/common/internal`), the string
// values did not.
const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';
const HTTP_CODE_METADATA = '__httpCode__';

function firstPath(value: unknown): string {
  const path: unknown = Array.isArray(value) ? (value as unknown[])[0] : value;
  return typeof path === 'string' ? path : '';
}

function normalisePath(...segments: string[]): string {
  const joined = segments
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join('/')
    .replace(/\/{2,}/g, '/')
    .replace(/\/$/, '');
  const withSlash = joined.startsWith('/') ? joined : `/${joined}`;
  return withSlash.length > 1 ? withSlash.replace(/\/$/, '') : withSlash;
}

export function requestMethodOf(context: ExecutionContext): RequestMethod {
  const method: unknown = Reflect.getMetadata(METHOD_METADATA, context.getHandler());
  return typeof method === 'number' ? method : RequestMethod.ALL;
}

/**
 * Low-cardinality route template, e.g. `"POST /payments/:id"`, built from the
 * controller and handler path metadata — never from the resolved request URL.
 */
export function routeTemplate(context: ExecutionContext, override?: string): string {
  if (override) {
    return override;
  }
  const controllerPath = firstPath(Reflect.getMetadata(PATH_METADATA, context.getClass()));
  const handlerPath = firstPath(Reflect.getMetadata(PATH_METADATA, context.getHandler()));
  return `${RequestMethod[requestMethodOf(context)]} ${normalisePath(controllerPath, handlerPath)}`;
}

/** Mirrors Nest's own rule: `@HttpCode()` if present, else 201 for POST and 200 otherwise. */
export function statusCodeFor(context: ExecutionContext): number {
  const explicit: unknown = Reflect.getMetadata(HTTP_CODE_METADATA, context.getHandler());
  if (typeof explicit === 'number') {
    return explicit;
  }
  return requestMethodOf(context) === RequestMethod.POST ? 201 : 200;
}
