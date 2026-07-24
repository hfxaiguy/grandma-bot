import type { ChatCompletionMessageParam, ChatCompletionUserMessageParam } from "openai/resources/chat/completions";

/** In-memory per-conversation history, keyed by "chatId:threadId" (each Telegram topic = one conversation). */
export class HistoryStore {
  private store = new Map<string, ChatCompletionMessageParam[]>();

  constructor(private limit: number) {}

  get(key: string): ChatCompletionMessageParam[] {
    let h = this.store.get(key);
    if (!h) {
      h = [];
      this.store.set(key, h);
    }
    return h;
  }

  appendUser(key: string, content: ChatCompletionUserMessageParam["content"]): ChatCompletionMessageParam[] {
    const h = this.get(key);
    h.push({ role: "user", content });
    while (h.length > this.limit) h.shift();
    return h;
  }

  clear(key: string): void {
    this.store.delete(key);
  }
}
