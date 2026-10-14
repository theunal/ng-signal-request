/*
 * Public API surface of ng-signal-request.
 */
export { provideSignalRequest, SIGNAL_REQUEST_CONFIG } from './lib/config';
export { createRequest } from './lib/create-request';
export type { CreateRequest, CreateRequestFn } from './lib/create-request';
export { createMutation } from './lib/create-mutation';
export type { CreateMutation } from './lib/create-mutation';
export { RequestCancelledError, requestErrorOf, toError, toRequestError } from './lib/errors';
export type {
  RequestError,
  RequestErrorContext,
  RequestErrorKind,
  RequestErrorOf,
  RequestErrorView,
} from './lib/errors';
export type {
  CacheOptions,
  CachedRequest,
  CachedRequestOptions,
  InvalidationTarget,
  MutationOptions,
  MutationStatus,
  OptimisticTarget,
  ParamsOption,
  PathParams,
  QueryParams,
  QueryPrimitive,
  QueryValue,
  RefetchOnMount,
  Reloadable,
  RequestBase,
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

/* -------------------------------------------------------------------------- */
/*  Cache                                                                     */
/* -------------------------------------------------------------------------- */

export { QueryCache, type CacheChangeListener } from './lib/cache/query-cache';
export { QueryClient, type Updater } from './lib/cache/query-client';
export { MutationRegistry } from './lib/cache/mutation-registry';
export { CacheEntry, type FetchPlan, type SettleOutcome } from './lib/cache/cache-entry';
export {
  formatKey,
  matchesFilter,
  normalizeKey,
  startsWith,
  type NormalizedKey,
  type QueryKey,
  type QueryKeyFactory,
  type QueryKeyFilter,
  type QueryKeyPredicate,
} from './lib/cache/key';
export {
  defaultStructuralSharing,
  resolveStructuralSharing,
  type StructuralSharingFn,
} from './lib/cache/structural-sharing';
