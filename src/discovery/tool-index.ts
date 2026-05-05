// src/discovery/tool-index.ts
// In-memory tool index for safari_tool_search meta-tool.
// Keyword overlap scoring with name + tag boost.

export interface ToolEntry {
  name: string;
  description: string;
  tags?: string[];
}

export interface ToolHit extends ToolEntry {
  score: number;
}

export class ToolIndex {
  private entries: ToolEntry[];

  constructor(entries: ToolEntry[]) {
    this.entries = entries.map((e) => ({
      ...e,
      tags: e.tags ?? this.inferTags(e.name),
    }));
  }

  size(): number {
    return this.entries.length;
  }

  tagsFor(name: string): string[] {
    return this.entries.find((e) => e.name === name)?.tags ?? [];
  }

  search(query: string, topK = 8): ToolHit[] {
    const tokens = this.tokenize(query);
    if (tokens.length === 0) return [];
    const scored = this.entries
      .map((e) => ({ ...e, score: this.score(tokens, e) }))
      .filter((h) => h.score > 0);
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  private inferTags(name: string): string[] {
    const parts = name.replace(/^safari_/, '').split('_');
    return parts[0] ? [parts[0]] : [];
  }

  private tokenize(s: string): string[] {
    return s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1);
  }

  private score(queryTokens: string[], e: ToolEntry): number {
    const haystack = (e.name + ' ' + e.description + ' ' + (e.tags ?? []).join(' ')).toLowerCase();
    let s = 0;
    for (const t of queryTokens) {
      if (haystack.includes(t)) s += 1;
      if (e.name.toLowerCase().includes(t)) s += 1; // boost name match
      if (e.tags?.includes(t)) s += 0.5;
    }
    return s;
  }
}
