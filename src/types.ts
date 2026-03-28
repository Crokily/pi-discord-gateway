/** Inbound message from Discord, ready for queue */
export interface InboundMessage {
  id: string;
  channelJid: string;
  sender: string;
  senderName: string;
  content: string;
  timestamp: string;
}

/** A registered channel the gateway will respond in */
export interface RegisteredChannel {
  jid: string;
  name: string;
  folder: string;
  requiresTrigger: boolean;
  isMain: boolean;
}

/** Queued message row from SQLite */
export interface QueuedMessage {
  rowid: number;
  channel_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
}

/** Agent invocation result */
export interface AgentResult {
  ok: boolean;
  text: string;
  error?: string;
}
