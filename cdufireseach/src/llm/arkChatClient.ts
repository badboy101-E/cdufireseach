type ChatRole = "system" | "user" | "assistant";

type ChatMessage = {
  role: ChatRole;
  content: string;
};

type ArkChatClientOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  timeoutMs?: number;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
};

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/g, "");
}

function extractJsonObject(text: string): string {
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fencedMatch?.[1]?.trim() || text.trim();
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("LLM response did not contain a JSON object");
  }
  return source.slice(start, end + 1);
}

export class ArkChatClient {
  readonly baseUrl: string;
  readonly model: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: ArkChatClientOptions) {
    this.baseUrl = stripTrailingSlash(options.baseUrl);
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  async complete(messages: ChatMessage[]): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;

    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.options.apiKey}`
        },
        body: JSON.stringify({
          model: this.options.model,
          temperature: this.options.temperature ?? 0.2,
          messages
        }),
        signal: controller.signal
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`ARK chat completion timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `ARK chat completion failed (${response.status}): ${errorText.slice(0, 500)}`
      );
    }

    const json = (await response.json()) as ChatCompletionResponse;
    const content = json.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error("ARK chat completion returned empty content");
    }
    return content;
  }

  async completeJson<T>(messages: ChatMessage[]): Promise<T> {
    const text = await this.complete(messages);
    const jsonText = extractJsonObject(text);
    return JSON.parse(jsonText) as T;
  }
}

export type { ChatMessage };
