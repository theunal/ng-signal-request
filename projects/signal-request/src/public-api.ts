/*
 * Public API surface of ng-signal-request.
 */
export { provideSignalRequest, SIGNAL_REQUEST_CONFIG } from './lib/config';
export { createRequest } from './lib/create-request';
export type { CreateRequest, CreateRequestFn } from './lib/create-request';
export { createMutation } from './lib/create-mutation';
export type { CreateMutation } from './lib/create-mutation';
export { RequestCancelledError, requestErrorOf, toError, toRequestError } from './lib/errors';
export type { RequestError, RequestErrorContext } from './lib/errors';
export type {
  MutationOptions,
  MutationStatus,
  ParamsOption,
  PathParams,
  QueryParams,
  QueryPrimitive,
  QueryValue,
  Reloadable,
  RequestConfig,
  RequestOptions,
  RequestSource,
  RequestStatus,
  RequestValue,
  RetryConfig,
  RetryOptions,
  RunResult,
  SignalMutation,
  SignalRequest,
  SignalRequestConfig,
} from './lib/types';
