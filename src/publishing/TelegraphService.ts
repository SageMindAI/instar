/**
 * Telegraph publishing service for Instar agents.
 *
 * Converts markdown to Telegraph Node format and publishes
 * content via the Telegraph API (telegra.ph). Zero-config,
 * no rate limits, instant web pages accessible from anywhere.
 *
 * IMPORTANT: All Telegraph pages are PUBLIC. There is no authentication
 * or access control — anyone with the URL can view the content.
 * Do NOT publish sensitive, private, or confidential information.
 * For private content, use the Cloudflare Tunnel viewer (when configured).
 *
 * Telegraph API docs: https://telegra.ph/api
 */

import fs from 'node:fs';
import path from 'node:path';

// ── Telegraph Node Types ───────────────────────────────────────────

/** Valid Telegraph element tags */
export type TelegraphTag =
  | 'a' | 'aside' | 'b' | 'blockquote' | 'br' | 'code'
  | 'em' | 'figcaption' | 'figure' | 'h3' | 'h4' | 'hr'
  | 'i' | 'iframe' | 'img' | 'li' | 'ol' | 'p' | 'pre'
  | 's' | 'strong' | 'u' | 'ul' | 'video';

/** Telegraph element node — tag with optional attrs and children */
export interface TelegraphElement {
  tag: TelegraphTag;
  attrs?: { href?: string; src?: string };
  children?: TelegraphNode[];
}

/** A Telegraph node is either a text string or an element */
export type TelegraphNode = string | TelegraphElement;

// ── Telegraph API Types ────────────────────────────────────────────

export interface TelegraphAccount {
  short_name: string;
  author_name?: string;
  author_url?: string;
  access_token: string;
  auth_url?: string;
}

export interface TelegraphPage {
  path: string;
  url: string;
  title: string;
  description?: string;
  views?: number;
  can_edit?: boolean;
}

export interface TelegraphPageList {
  total_count: number;
  pages: TelegraphPage[];
}

// ── Local Page Index ───────────────────────────────────────────────

export interface PublishedPage {
  path: string;
  url: string;
  title: string;
  publishedAt: string;
  updatedAt?: string;
  /** Original markdown for diffing/re-publishing */
  markdownHash?: string;
  /** Access token used to create this page (required for editing) */
  accessToken?: string;
}

export interface PublishingState {
  accessToken?: string;
  shortName?: string;
  authorName?: string;
  pages: PublishedPage[];
}

// ── Config ─────────────────────────────────────────────────────────

export interface TelegraphConfig {
  /** State directory where publishing.json is stored */
  stateDir: string;
  /** Short name for the Telegraph account (e.g., agent name) */
  shortName?: string;
  /** Author name shown on published pages */
  authorName?: string;
  /** Author URL shown on published pages */
  authorUrl?: string;
}

// ── Service ────────────────────────────────────────────────────────

const TELEGRAPH_API = 'https://api.telegra.ph';

export class TelegraphService {
  private config: TelegraphConfig;
  private stateFile: string;
  private state: PublishingState;

  constructor(config: TelegraphConfig) {
    this.config = config;
    this.stateFile = path.join(config.stateDir, 'publishing.json');
    this.state = this.loadState();
  }

  // ── Account Management ─────────────────────────────────────────

  /**
   * Ensure a Telegraph account exists. Creates one if needed.
   * Returns the access token.
   */
  async ensureAccount(): Promise<string> {
    if (this.state.accessToken) {
      return this.state.accessToken;
    }

    const shortName = this.config.shortName || 'instar-agent';
    const account = await this.createAccount(shortName, this.config.authorName);
    this.state.accessToken = account.access_token;
    this.state.shortName = account.short_name;
    this.state.authorName = account.author_name;
    this.saveState();
    return account.access_token;
  }

  /**
   * Create a new Telegraph account.
   */
  async createAccount(shortName: string, authorName?: string): Promise<TelegraphAccount> {
    const params: Record<string, string> = { short_name: shortName };
    if (authorName) params.author_name = authorName;
    if (this.config.authorUrl) params.author_url = this.config.authorUrl;

    const result = await this.apiCall<TelegraphAccount>('createAccount', params);
    return result;
  }

  // ── Publishing ─────────────────────────────────────────────────

  /**
   * Publish markdown content as a PUBLIC Telegraph page.
   *
   * WARNING: The published page is publicly accessible to anyone with the URL.
   * Do not publish sensitive or private information.
   *
   * Returns the page URL and path.
   */
  async publishPage(title: string, markdown: string): Promise<TelegraphPage> {
    const token = await this.ensureAccount();
    const content = markdownToNodes(markdown);

    // Validate content size (Telegraph limit: 64KB)
    const contentJson = JSON.stringify(content);
    if (contentJson.length > 64000) {
      throw new Error(`Content too large for Telegraph: ${contentJson.length} bytes (max 64000)`);
    }

    const page = await this.apiCall<TelegraphPage>('createPage', {
      access_token: token,
      title,
      content: contentJson,
      author_name: this.state.authorName || this.config.authorName,
      author_url: this.config.authorUrl,
      return_content: 'false',
    });

    // Track locally (store token so edits use the correct credential)
    this.state.pages.push({
      path: page.path,
      url: page.url,
      title,
      publishedAt: new Date().toISOString(),
      markdownHash: simpleHash(markdown),
      accessToken: token,
    });
    this.saveState();

    return page;
  }

  /**
   * Edit an existing Telegraph page.
   * Uses the original access token stored when the page was created.
   * Throws a clear error if the page is orphaned (token lost/rotated).
   */
  async editPage(pagePath: string, title: string, markdown: string): Promise<TelegraphPage> {
    const existing = this.state.pages.find(p => p.path === pagePath);
    // Prefer the per-page token (if stored), fall back to current account token
    const token = existing?.accessToken || await this.ensureAccount();

    const content = markdownToNodes(markdown);

    const contentJson = JSON.stringify(content);
    if (contentJson.length > 64000) {
      throw new Error(`Content too large for Telegraph: ${contentJson.length} bytes (max 64000)`);
    }

    try {
      const page = await this.apiCall<TelegraphPage>('editPage', {
        access_token: token,
        path: pagePath,
        title,
        content: contentJson,
        author_name: this.state.authorName || this.config.authorName,
        author_url: this.config.authorUrl,
        return_content: 'false',
      });

      // Update local index
      if (existing) {
        existing.title = title;
        existing.updatedAt = new Date().toISOString();
        existing.markdownHash = simpleHash(markdown);
      }
      this.saveState();

      return page;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('PAGE_ACCESS_DENIED')) {
        throw new Error(
          `Cannot edit page "${pagePath}" — access denied. ` +
          `The access token used to create this page ${existing?.accessToken ? 'does not match' : 'was not stored (created before token tracking)'}. ` +
          `This page is orphaned and can only be viewed, not edited.`
        );
      }
      throw err;
    }
  }

  /**
   * Get page view count from Telegraph.
   */
  async getPageViews(pagePath: string): Promise<number> {
    const result = await this.apiCall<{ views: number }>('getViews', { path: pagePath });
    return result.views;
  }

  /**
   * List all locally tracked published pages.
   */
  listPages(): PublishedPage[] {
    return [...this.state.pages];
  }

  /**
   * Get state for inspection/testing.
   */
  getState(): PublishingState {
    return { ...this.state };
  }

  // ── Internal ───────────────────────────────────────────────────

  private loadState(): PublishingState {
    try {
      if (fs.existsSync(this.stateFile)) {
        return JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
      }
    } catch {
      // Corrupted file — start fresh
    }
    return { pages: [] };
  }

  private saveState(): void {
    const dir = path.dirname(this.stateFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
  }

  private async apiCall<T>(method: string, params: Record<string, string | undefined>): Promise<T> {
    // Filter out undefined values
    const body: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) body[k] = v;
    }

    const response = await fetch(`${TELEGRAPH_API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Telegraph API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as { ok: boolean; result?: T; error?: string };
    if (!data.ok || !data.result) {
      throw new Error(`Telegraph API error: ${data.error || 'Unknown error'}`);
    }

    return data.result;
  }
}

// ── Markdown to Telegraph Node Conversion ──────────────────────────

/**
 * Convert markdown text to Telegraph Node[] format.
 *
 * Supports: headings (h3/h4), bold, italic, strikethrough, code,
 * code blocks, links, images, blockquotes, lists (ol/ul),
 * horizontal rules, and paragraphs.
 *
 * Telegraph only supports h3 and h4, so # and ## map to h3,
 * ### maps to h3, #### and deeper map to h4.
 */
export function markdownToNodes(markdown: string): TelegraphNode[] {
  const lines = markdown.split('\n');
  const nodes: TelegraphNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip empty lines
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
      nodes.push({ tag: 'hr' });
      i++;
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const tag: TelegraphTag = level <= 3 ? 'h3' : 'h4';
      nodes.push({ tag, children: parseInline(headingMatch[2].trim()) });
      i++;
      continue;
    }

    // Code blocks (fenced)
    if (line.trim().startsWith('```')) {
      const codeLines: string[] = [];
      i++; // skip opening fence
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      nodes.push({
        tag: 'pre',
        children: [{ tag: 'code', children: [codeLines.join('\n')] }],
      });
      continue;
    }

    // Blockquote
    if (line.trimStart().startsWith('> ')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith('> ')) {
        quoteLines.push(lines[i].trimStart().replace(/^>\s?/, ''));
        i++;
      }
      nodes.push({
        tag: 'blockquote',
        children: parseInline(quoteLines.join('\n')),
      });
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s/.test(line)) {
      const items: TelegraphNode[][] = [];
      while (i < lines.length && /^\s*[-*+]\s/.test(lines[i])) {
        const itemText = lines[i].replace(/^\s*[-*+]\s+/, '');
        items.push(parseInline(itemText));
        i++;
      }
      nodes.push({
        tag: 'ul',
        children: items.map(children => ({ tag: 'li' as TelegraphTag, children })),
      });
      continue;
    }

    // Ordered list
    if (/^\s*\d+[.)]\s/.test(line)) {
      const items: TelegraphNode[][] = [];
      while (i < lines.length && /^\s*\d+[.)]\s/.test(lines[i])) {
        const itemText = lines[i].replace(/^\s*\d+[.)]\s+/, '');
        items.push(parseInline(itemText));
        i++;
      }
      nodes.push({
        tag: 'ol',
        children: items.map(children => ({ tag: 'li' as TelegraphTag, children })),
      });
      continue;
    }

    // Image (standalone line)
    const imgMatch = line.trim().match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (imgMatch) {
      const figChildren: TelegraphNode[] = [
        { tag: 'img', attrs: { src: imgMatch[2] } },
      ];
      if (imgMatch[1]) {
        figChildren.push({ tag: 'figcaption', children: [imgMatch[1]] });
      }
      nodes.push({ tag: 'figure', children: figChildren });
      i++;
      continue;
    }

    // Regular paragraph — collect contiguous non-empty, non-special lines
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].trim().startsWith('#') &&
      !lines[i].trim().startsWith('```') &&
      !lines[i].trimStart().startsWith('> ') &&
      !/^\s*[-*+]\s/.test(lines[i]) &&
      !/^\s*\d+[.)]\s/.test(lines[i]) &&
      !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i].trim()) &&
      !/^!\[([^\]]*)\]\(([^)]+)\)$/.test(lines[i].trim())
    ) {
      paraLines.push(lines[i]);
      i++;
    }

    if (paraLines.length > 0) {
      nodes.push({ tag: 'p', children: parseInline(paraLines.join('\n')) });
    }
  }

  return nodes;
}

/**
 * Parse inline markdown formatting into Telegraph nodes.
 *
 * Handles: **bold**, *italic*, ~~strikethrough~~, `code`,
 * [links](url), and nested combinations.
 */
export function parseInline(text: string): TelegraphNode[] {
  const nodes: TelegraphNode[] = [];

  // Regex for inline patterns — ordered by priority
  // Bold: **text** or __text__
  // Italic: *text* or _text_ (but not **text**)
  // Strikethrough: ~~text~~
  // Code: `text`
  // Link: [text](url)
  // Image inline: ![alt](src)
  const inlinePattern = /(\*\*(.+?)\*\*|__(.+?)__|\*(.+?)\*|_([^_]+?)_|~~(.+?)~~|`([^`]+?)`|\[([^\]]+?)\]\(([^)]+?)\)|!\[([^\]]*?)\]\(([^)]+?)\))/;

  let remaining = text;

  while (remaining.length > 0) {
    const match = inlinePattern.exec(remaining);

    if (!match) {
      // No more inline formatting — push rest as text
      if (remaining) {
        // Convert \n to <br> within inline text
        const parts = remaining.split('\n');
        for (let i = 0; i < parts.length; i++) {
          if (parts[i]) nodes.push(parts[i]);
          if (i < parts.length - 1) nodes.push({ tag: 'br' });
        }
      }
      break;
    }

    // Push text before the match
    const before = remaining.slice(0, match.index);
    if (before) {
      const parts = before.split('\n');
      for (let i = 0; i < parts.length; i++) {
        if (parts[i]) nodes.push(parts[i]);
        if (i < parts.length - 1) nodes.push({ tag: 'br' });
      }
    }

    const fullMatch = match[0];

    if (match[2] || match[3]) {
      // Bold: **text** or __text__
      const inner = match[2] || match[3];
      nodes.push({ tag: 'strong', children: parseInline(inner) });
    } else if (match[4] || match[5]) {
      // Italic: *text* or _text_
      const inner = match[4] || match[5];
      nodes.push({ tag: 'em', children: parseInline(inner) });
    } else if (match[6]) {
      // Strikethrough: ~~text~~
      nodes.push({ tag: 's', children: parseInline(match[6]) });
    } else if (match[7]) {
      // Inline code: `text`
      nodes.push({ tag: 'code', children: [match[7]] });
    } else if (match[10] !== undefined && match[11]) {
      // Image: ![alt](src)
      nodes.push({ tag: 'img', attrs: { src: match[11] } });
    } else if (match[8] && match[9]) {
      // Link: [text](url)
      nodes.push({ tag: 'a', attrs: { href: match[9] }, children: parseInline(match[8]) });
    }

    remaining = remaining.slice(match.index + fullMatch.length);
  }

  return nodes;
}

/**
 * Simple string hash for change detection (not cryptographic).
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0; // Convert to 32-bit integer
  }
  return hash.toString(36);
}
