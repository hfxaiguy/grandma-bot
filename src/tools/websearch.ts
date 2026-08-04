const EXA_SEARCH_URL = "https://api.exa.ai/search";
const TIMEOUT_MS = 30_000;
const MAX_TEXT_CHARS = 8_000;

const CATEGORIES = new Set([
  "company", "people", "publication", "news", "personal site", "financial report",
]);

const SEARCH_TYPES = new Set(["auto", "fast", "instant", "deep-lite", "deep", "deep-reasoning"]);

export interface ExaSearchArgs {
  query: string;
  type?: string;
  numResults?: number;
  category?: string;
  includeDomains?: string[];
  startPublishedDate?: string;
  endPublishedDate?: string;
}

interface ExaResult {
  title?: string | null;
  url?: string | null;
  publishedDate?: string | null;
  highlights?: string[];
  text?: string | null;
}

interface ExaResponse {
  results?: ExaResult[];
}

export interface ExaSearchOutput {
  query: string;
  count: number;
  results: ExaResult[];
  [key: string]: string | number | ExaResult[];
}

export class ExaSearchTools {
  constructor(private apiKey: string) {}

  /**
   * Structured search result: a plain JSON object. Errors (bad key,
   * API failure, etc.) are returned as "error:" strings instead — never
   * thrown — so the agent can recover. No truncation is applied: the full
   * object is returned as-is.
   */
  async search(args: ExaSearchArgs): Promise<string | ExaSearchOutput> {
    if (!this.apiKey) {
      return "error: web search not configured (set EXO_API_KEY in .env)";
    }
    const query = String(args.query ?? "").trim();
    if (!query) return "error: missing required argument: query";

    const body: Record<string, unknown> = {
      query,
      type: args.type ?? "auto",
      numResults: Math.min(Math.max(Math.floor(args.numResults ?? 5), 1), 100),
      contents: {
        highlights: true,
        text: { maxCharacters: MAX_TEXT_CHARS },
      },
    };
    if (args.category) {
      if (!CATEGORIES.has(args.category)) {
        return `error: invalid category "${args.category}" (allowed: ${[...CATEGORIES].join(", ")})`;
      }
      body.category = args.category;
    }
    if (args.type && !SEARCH_TYPES.has(args.type)) {
      return `error: invalid type "${args.type}" (allowed: ${[...SEARCH_TYPES].join(", ")})`;
    }
    if (args.includeDomains?.length) body.includeDomains = args.includeDomains;
    if (args.startPublishedDate) body.startPublishedDate = args.startPublishedDate;
    if (args.endPublishedDate) body.endPublishedDate = args.endPublishedDate;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(EXA_SEARCH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      return `error: exa API ${err instanceof Error && err.name === "AbortError" ? `timed out after ${TIMEOUT_MS / 1000}s` : `request failed: ${err instanceof Error ? err.message : String(err)}`}`;
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const text = await res.text();
        if (text) detail += `: ${text.slice(0, 500)}`;
      } catch {
        // ignore body read failure
      }
      return `error: exa API ${detail}`;
    }

    let data: ExaResponse;
    try {
      data = (await res.json()) as ExaResponse;
    } catch {
      return "error: exa API returned invalid JSON";
    }

    const results = (data.results ?? []).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      publishedDate: r.publishedDate ?? null,
      highlights: r.highlights ?? [],
      text: r.text ?? null,
    }));

    return { query, count: results.length, results };
  }
}
