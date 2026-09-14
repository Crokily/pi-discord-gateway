/** Supported pi thinking levels */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** A registered channel the gateway will respond in */
export interface RegisteredChannel {
  jid: string;
  name: string;
  folder: string;
  requiresTrigger: boolean;
  isMain: boolean;
  modelOverride: string;
  thinkingOverride: ThinkingLevel | '';
  cwdOverride: string;
  parentJid?: string;
  threadMode?: 'off' | 'auto';
  managedThread?: boolean;
  deletedAt?: string;
}

/** Queued message row from SQLite */
export interface QueuedMessage {
  rowid: number;
  channel_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  status:
    | 'pending'
    | 'routing'
    | 'processing'
    | 'delivering'
    | 'done'
    | 'failed'
    | 'interrupted'
    | 'cancelled'
    | 'delivery_failed'
    | 'delivery_uncertain';
  source_message_id: string | null;
  origin_jid: string | null;
  route_thread: number;
  anchor_message_id: string | null;
  response_text: string | null;
  delivery_attempts: number;
  next_attempt_at: number;
  /** JSON array of attachment metadata, or null */
  attachments: string | null;
}

/** Agent invocation result */
export interface AgentResult {
  ok: boolean;
  text: string;
  error?: string;
  reason?: 'cancelled' | 'timeout';
}
