export type RawEventKind = 'net' | 'route' | 'viewport';

/**
 * `twe.raw.v1` compatibility policy:
 * - Additive-only field evolution inside v1.
 * - No destructive field renames/removals in v1.
 * - Breaking changes require a new schema version (e.g. `twe.raw.v2`).
 */

export interface RawCaptureNetPayload {
  transport: 'xhr' | 'fetch' | 'other';
  phase: 'response';
  method: string;
  url_raw_redacted: string;
  url_norm: string;
  status?: number;
  req_body_hash?: string;
  resp_content_type?: string;
  resp_body_ref?: string;
  resp_body_hash?: string;
  resp_body_size?: number;
  resp_truncated?: boolean;
  resp_body_sample?: string;
}

export interface RawCaptureRecorderInfo {
  recorder_rev: number;
  hook_rev?: number;
  modes?: {
    safeMode?: boolean;
    hookMode?: string;
    repairMode?: string;
  };
  capabilities?: {
    hasExportFunction?: boolean;
    hasWrappedJSObject?: boolean;
  };
  spool?: {
    queued?: number;
    enqueued_total?: number;
    flushed_total?: number;
    failed_total?: number;
    oldest_pending_age_ms?: number;
  };
  coordination?: {
    role?: 'leader' | 'follower' | 'single';
    leader_tab_id?: string;
    lease_heartbeat_ms?: number;
  };
  warnings?: string[];
}

export interface RawCaptureRoutePayload {
  source?: string;
  pathname: string;
  search?: string;
  hash?: string;
}

export interface RawCaptureViewportPayload {
  tweet_id: string;
  source?: string;
}

export interface RawEventEnvelopeV1 {
  schema: 'twe.raw.v1';
  event_id: string;
  prev_event_hash?: string;
  event_hash: string;
  wall_time_ms: number;
  mono_time_ms: number;
  tz_offset_min: number;
  page_url: string;
  route_type: string;
  route_params?: Record<string, string>;
  route_epoch: number;
  kind: RawEventKind;
  session_id?: string;
  tab_id?: string;
  account_hint?: {
    user_rest_id?: string;
  };
  net?: RawCaptureNetPayload;
  route?: RawCaptureRoutePayload;
  viewport?: RawCaptureViewportPayload;
  recorder?: RawCaptureRecorderInfo;
}

export interface RawCaptureStats {
  total: number;
  emitted: number;
  dropped: number;
  last_at: number;
  last_event_id?: string;
  last_event_hash?: string;
  spool_count?: number;
  spool_enqueued?: number;
  spool_flushed?: number;
  spool_failed?: number;
  spool_drop_overflow?: number;
  spool_unavailable?: number;
  oldest_pending_age_ms?: number;
  daemon_online?: boolean;
  daemon_last_flush_at?: number;
  daemon_last_error?: string;
  monitor_role?: 'leader' | 'follower' | 'single';
  monitor_leader_tab_id?: string;
  monitor_last_heartbeat_ms?: number;
  monitor_ticks_route?: number;
  monitor_ticks_viewport?: number;
  monitor_suppressed_route?: number;
  monitor_suppressed_viewport?: number;
  dm_policy_blocks?: number;
  dm_policy_last_route_type?: string;
  dm_policy_last_policy_class?: string;
}
