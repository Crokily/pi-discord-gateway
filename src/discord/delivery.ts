import {
  beginChunk,
  finishChunk,
  getQueuedMessage,
  getResponseChunks,
  retryDelivery,
  resetUnsentChunk,
  setMessageState,
  type ResponseChunk,
} from '../db.js';

export interface DeliveryTransport {
  send(jid: string, content: string, nonce: string): Promise<string>;
  find(jid: string, nonce: string): Promise<string | undefined>;
}

export async function deliverResponse(
  rowid: number,
  transport: DeliveryTransport,
  signal: AbortSignal,
): Promise<boolean> {
  const message = getQueuedMessage(rowid);
  if (!message || message.status !== 'delivering') return false;
  for (const chunk of getResponseChunks(rowid)) {
    if (chunk.status === 'sent') continue;
    if (signal.aborted || getQueuedMessage(rowid)?.status !== 'delivering') return false;
    try {
      const previous =
        chunk.status === 'sending'
          ? await transport.find(message.channel_jid, chunk.nonce).catch(() => undefined)
          : undefined;
      if (previous) {
        finishChunk(rowid, chunk.part, previous);
        continue;
      }
      if (signal.aborted || getQueuedMessage(rowid)?.status !== 'delivering') return false;
      if (isUncertainChunk(chunk)) {
        setMessageState(
          rowid,
          'delivery_uncertain',
          `Delivery of task #${rowid} could not be confirmed. The saved answer is available with piscord result ${rowid}; the task will not run again.`,
        );
        return false;
      }
      if (signal.aborted) return false;
      beginChunk(rowid, chunk.part);
      const id = await transport.send(message.channel_jid, chunk.content, chunk.nonce);
      finishChunk(rowid, chunk.part, id);
    } catch (error) {
      // A late network result must not overwrite /stop or shutdown state.
      if (signal.aborted || getQueuedMessage(rowid)?.status !== 'delivering') return false;
      const failure = error as { status?: number; name?: string; timeToReset?: number };
      const status = failure.status;
      const rateLimited = status === 429 || failure.name === 'RateLimitError';
      if (rateLimited || (status && status >= 400 && status < 500))
        resetUnsentChunk(rowid, chunk.part);
      if (status && status >= 400 && status < 500 && status !== 429) {
        setMessageState(
          rowid,
          'delivery_failed',
          `Could not deliver task #${rowid} (Discord ${status}). Its answer was saved; use piscord result ${rowid}.`,
        );
      } else if ((getQueuedMessage(rowid)?.delivery_attempts ?? 0) >= 2) {
        setMessageState(
          rowid,
          'delivery_uncertain',
          `Delivery of task #${rowid} failed after retries. Its answer was saved; use piscord result ${rowid}. Check Discord before sending it again.`,
        );
      } else {
        const delay =
          rateLimited && Number.isFinite(failure.timeToReset)
            ? Math.max(1_000, Math.min(failure.timeToReset! + 500, 300_000))
            : 5_000;
        retryDelivery(rowid, delay);
      }
      return false;
    }
  }
  return !signal.aborted && getQueuedMessage(rowid)?.status === 'delivering';
}

// Discord only promises nonce deduplication for the past few minutes.
export function isUncertainChunk(chunk: ResponseChunk): boolean {
  return (
    chunk.status === 'sending' && (!chunk.sending_at || Date.now() - chunk.sending_at > 120_000)
  );
}

export function splitResponse(text: string, max = 2000): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > max) {
    let end = remaining.lastIndexOf('\n', max);
    if (end <= 0) end = max;
    const last = remaining.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end).replace(/^\n/, '');
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
