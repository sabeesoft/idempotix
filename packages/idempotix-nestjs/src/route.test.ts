import { Controller, Get, HttpCode, Post, type ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { routeTemplate, statusCodeFor } from './route.js';

@Controller('payments/')
class PaymentsController {
  @Post(':id/capture')
  capture(): void {
    // no-op
  }

  @Get()
  list(): void {
    // no-op
  }

  @Post('refunds')
  @HttpCode(202)
  refund(): void {
    // no-op
  }
}

function contextFor(handlerName: keyof PaymentsController): ExecutionContext {
  // Nest hands interceptors the unbound prototype method; mirror that here.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const handler = PaymentsController.prototype[handlerName];
  return {
    getClass: () => PaymentsController,
    getHandler: () => handler,
  } as unknown as ExecutionContext;
}

describe('routeTemplate', () => {
  it('joins controller and handler paths with the method name', () => {
    expect(routeTemplate(contextFor('capture'))).toBe('POST /payments/:id/capture');
  });

  it('normalises empty handler paths and trailing slashes', () => {
    expect(routeTemplate(contextFor('list'))).toBe('GET /payments');
  });

  it('prefers an explicit override', () => {
    expect(routeTemplate(contextFor('capture'), 'payments.capture')).toBe('payments.capture');
  });
});

describe('statusCodeFor', () => {
  it('uses @HttpCode when present', () => {
    expect(statusCodeFor(contextFor('refund'))).toBe(202);
  });

  it('defaults to 201 for POST and 200 otherwise', () => {
    expect(statusCodeFor(contextFor('capture'))).toBe(201);
    expect(statusCodeFor(contextFor('list'))).toBe(200);
  });
});
