import type { Gateway } from '../policy/gateway.ts';
import type { ComputerManager } from '../computer/manager.ts';
import { openBrowserText } from '../computer/effects.ts';
import type { ToolEffectPort } from './tool-effects.ts';

/** One host-owned Gateway supplies preparation, readiness and the browser's sole dispatch. */
export function browserTextPort(gateway: Gateway, computers: ComputerManager): ToolEffectPort {
  return {
    prepare: request => gateway.prepare(request),
    status: operationId => gateway.status(operationId),
    ready: (request, reviewId) => gateway.reviewReady(request, reviewId),
    open: (request, reviewId) => gateway.pendingReview(reviewId, request) !== undefined,
    dispatch: (request, reviewId) => {
      const facade = { dispatch: (effect: Parameters<Gateway['dispatch']>[0], invoke: Parameters<Gateway['dispatch']>[1]) => gateway.dispatchReviewed(effect, reviewId, invoke) };
      return openBrowserText(facade as unknown as Gateway, computers, request);
    },
  };
}
