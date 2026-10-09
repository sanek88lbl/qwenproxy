import { createHash } from 'node:crypto';
import { prepareConversationMessage, type ConversationMessage } from '../utils/conversation-serialization.js';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export function conversationHistory(messages: ConversationMessage[]): ConversationMessage[] {
  return messages.filter(message => message.role !== 'system' && message.role !== 'developer').map(message => {
    const prepared = prepareConversationMessage(message);
    return { ...prepared, tool_calls: prepared.tool_calls?.map(call => ({ id: call.id, type: call.type ?? 'function',
      function: { name: call.function?.name, arguments: call.function?.arguments ?? '{}' } })) };
  });
}
export function historyFingerprint(messages: ConversationMessage[]): string {
  return createHash('sha256').update(JSON.stringify(canonical(conversationHistory(messages)))).digest('hex');
}
export function matchesConfirmedHistory(messages: ConversationMessage[], session: { confirmedHistoryHash?: string; confirmedHistoryLength?: number }): boolean {
  const history = conversationHistory(messages);
  const length = session.confirmedHistoryLength ?? 0;
  return !!session.confirmedHistoryHash && length > 0 && history.length > length && historyFingerprint(history.slice(0, length)) === session.confirmedHistoryHash;
}
