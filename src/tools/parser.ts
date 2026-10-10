/*
 * File: parser.ts
 * Project: qwenproxy
 * Streaming parser for <tool_call> tags - OpenAI Compatible
 * Supports both JSON and Hermes-style XML <parameter> formats.
 */

import crypto from 'crypto';
import { robustParseJSON } from '../utils/json.js';
import { logger } from '../core/logger.js';
import { metrics } from '../core/metrics.js';
import type { ParsedToolCall } from './types';
import type { FunctionToolDefinition } from './types';
import {
  TOOL_CALL_OPEN,
  closeTagFor,
  findToolOpen,
  getCloseNames,
  getOpenNames,
  matchToolCloseAt,
  openTagName,
} from './toolcall-tags.js';

// Throttled logging for noisy-but-benign conditions (model echoing source files
// that contain <tool_call> literals, truncated blocks, etc.). Full log entries
// are emitted at most once per WARN_INTERVAL per key, with a cumulative counter,
// so a flood of malformed blocks does not spam the log.
const warnState = new Map<string, { lastAt: number; count: number }>();
const WARN_INTERVAL = 5000;
function throttledWarn(key: string, buildMsg: (count: number) => void): void {
  const state = warnState.get(key) || { lastAt: 0, count: 0 };
  state.count++;
  warnState.set(key, state);
  if (state.count <= 3 || Date.now() - state.lastAt > WARN_INTERVAL) {
    state.lastAt = Date.now();
    buildMsg(state.count);
  }
}

export interface ParserResult {
  text: string;
  toolCalls: ParsedToolCall[];
}

// ─── XML Helpers ───────────────────────────────────────────────────────────────

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Strips leading/trailing stray `</tool_call >` / `</tool >` / `</qpx_call >`
// fragments the provider sometimes injects (e.g. an extra close after the real
// one). Applied to any text we emit so these artifacts never leak into the
// assistant reply.
function stripLeadingStrayCloses(s: string): string {
  const re = /^\s*<\/tool_call\s*>|^\s*<\/tool\s*>|^\s*<\/qpx_call\s*>/i;
  let m: RegExpMatchArray | null;
  while ((m = s.match(re))) s = s.substring(m[0].length);
  return s;
}
function stripTrailingStrayCloses(s: string): string {
  const re = /<\/tool_call\s*>\s*$|<\/tool\s*>\s*$|<\/qpx_call\s*>\s*$/i;
  let m: RegExpMatchArray | null;
  while ((m = s.match(re))) s = s.substring(0, s.length - m[0].length);
  return s;
}
function sanitizeStrayCloses(s: string): string {
  return stripTrailingStrayCloses(stripLeadingStrayCloses(s));
}

function unescapeDoubleEscaped(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return content;
  
  const isJsonLike = trimmed.startsWith('{') || trimmed.startsWith('[');
  const isXmlLike = trimmed.startsWith('<');
  
  if (!isJsonLike && !isXmlLike) return content;
  
  const firstQuoteIdx = trimmed.indexOf('"');
  if (firstQuoteIdx === -1) return content;
  
  const firstEscapedQuoteIdx = trimmed.indexOf('\\"');
  
  if (firstEscapedQuoteIdx !== -1 && (firstQuoteIdx === -1 || firstEscapedQuoteIdx < firstQuoteIdx)) {
    return content
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  
  return content;
}

function normalizeToolCallObject(parsed: any): any {
  if (parsed?.type === 'function' && parsed.function) {
    return {
      id: parsed.id,
      name: parsed.function.name,
      arguments: parsed.function.arguments ?? parsed.arguments ?? {},
      tool_call_id: parsed.tool_call_id,
    };
  }
  return parsed;
}

function splitTopLevelJsonValues(input: string): string[] {
  const values: string[] = [];
  let start = -1;
  let braceDepth = 0;
  let bracketDepth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if ((ch === '{' || ch === '[') && braceDepth === 0 && bracketDepth === 0) {
      start = i;
    }
    if (ch === '{') braceDepth++;
    if (ch === '}') braceDepth--;
    if (ch === '[') bracketDepth++;
    if (ch === ']') bracketDepth--;

    if (start !== -1 && braceDepth === 0 && bracketDepth === 0 && (ch === '}' || ch === ']')) {
      values.push(input.slice(start, i + 1));
      start = -1;
    }
  }

  return values;
}

function coerceParameterValue(rawValue: string): unknown {
  const value = decodeXmlEntities(rawValue.trim());
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']'))) {
    try { return JSON.parse(value); } catch { /* ignore */ }
  }
  return value;
}

/**
 * Extract tool name from the opening tag attribute or a <name> child element.
 */
function extractToolName(openTag: string, block: string): string {
  const combined = `${openTag}\n${block}`;
  const name = openTagName(openTag);
  const attrMatch = combined.match(new RegExp(`<${name}\\b[^>]*\\bname\\s*=\\s*["']([^"']+)["']`, 'i'));
  if (attrMatch) return attrMatch[1];

  const nameTagMatch = block.match(/<name>([\s\S]*?)<\/name>/i);
  if (nameTagMatch) return decodeXmlEntities(nameTagMatch[1].trim());

  return '';
}

/**
 * Infer tool name by matching parameter keys against tool definitions.
 * Only returns a name if exactly one tool matches all argument keys.
 */
function inferToolNameFromParameters(args: Record<string, unknown>, tools: FunctionToolDefinition[]): string {
  const argKeys = Object.keys(args);
  if (argKeys.length === 0 || !Array.isArray(tools)) return '';

  const matches = tools.filter((tool) => {
    const fn = tool?.type === 'function' ? tool.function : (tool as any)?.function;
    const properties = fn?.parameters?.properties || {};
    return argKeys.every(k => Object.prototype.hasOwnProperty.call(properties, k));
  });

  if (matches.length === 1) {
    const fn = matches[0]?.type === 'function' ? matches[0].function : (matches[0] as any)?.function;
    return fn?.name || '';
  }

  return '';
}

function parseFunctionShorthandToolCall(
  block: string
): { name: string; arguments: Record<string, unknown> } | null {
  const fnMatch = block.match(/<function=([^\s>]+)>/i);
  if (!fnMatch) return null;

  const args: Record<string, unknown> = {};
  const paramRe = /<parameter=([^\s>]+)>([\s\S]*?)<\/parameter>/gi;
  let match: RegExpExecArray | null;
  while ((match = paramRe.exec(block)) !== null) {
    args[match[1]] = coerceParameterValue(match[2]);
  }

  if (Object.keys(args).length === 0) return null;
  return { name: fnMatch[1], arguments: args };
}

/**
 * Parse Hermes-style XML <parameter name="...">value</parameter> format.
 */
function parseXmlParameterToolCall(
  block: string,
  openTag: string,
  tools: FunctionToolDefinition[]
): { name: string; arguments: Record<string, unknown> } | null {
  const args: Record<string, unknown> = {};
  const parameterRe = /<parameter\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;
  let match: RegExpExecArray | null;
  while ((match = parameterRe.exec(block)) !== null) {
    args[match[1]] = coerceParameterValue(match[2]);
  }

  if (Object.keys(args).length === 0) return null;

  const toolName = extractToolName(openTag, block) || inferToolNameFromParameters(args, tools);
  if (!toolName) return null;

  return { name: toolName, arguments: args };
}

/**
 * Try to recover a tool call from a block that may have unclosed <parameter> tags
 * (e.g. stream was cut off before </parameter> or </tool_call>).
 */
function parseRecoverableXmlToolCall(
  block: string,
  openTag: string,
  tools: FunctionToolDefinition[]
): { name: string; arguments: Record<string, unknown> } | null {
  const args: Record<string, unknown> = {};

  // First, extract all properly closed parameters
  const closedParameterRe = /<parameter\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;
  let match: RegExpExecArray | null;
  let lastClosedEnd = 0;
  while ((match = closedParameterRe.exec(block)) !== null) {
    args[match[1]] = coerceParameterValue(match[2]);
    lastClosedEnd = closedParameterRe.lastIndex;
  }

  // Then look for an unclosed parameter at the tail
  const tail = block.substring(lastClosedEnd);
  const unclosedMatch = tail.match(/<parameter\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*)$/i);
  if (unclosedMatch) {
    args[unclosedMatch[1]] = coerceParameterValue(unclosedMatch[2]);
  }

  if (Object.keys(args).length === 0) return null;

  const toolName = extractToolName(openTag, block) || inferToolNameFromParameters(args, tools);
  if (!toolName) return null;

  return { name: toolName, arguments: args };
}

// ─── String-Aware Tag Detection ─────────────────────────────────────────────────

function matchesCaseInsensitiveAt(buffer: string, index: number, value: string): boolean {
  if (index + value.length > buffer.length) return false;
  for (let j = 0; j < value.length; j++) {
    const c = buffer.charCodeAt(index + j);
    const t = value.charCodeAt(j);
    if (c !== t && (c | 0x20) !== (t | 0x20)) return false;
  }
  return true;
}

function findToolEndMatch(buffer: string): { index: number; length: number } | null {
  let inString = false;
  let escaped = false;

  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString || ch !== '<') continue;

    // Whitespace-tolerant close over every accepted tag (custom + legacy). The
    // provider sometimes inserts a space before `>`, and may emit the legacy
    // `</tool_call >`. Scanned outside JSON strings to avoid matching literal
    // close tags embedded in arguments.
    const closeLen = matchToolCloseAt(buffer, i);
    if (closeLen !== null) {
      return { index: i, length: closeLen };
    }

    // Some editor clients append environment metadata immediately after a model
    // emits a truncated closing tag, producing values like
    // `</tool<environment_details>` or `</<environment_details>`. Treat only
    // those prefixes as closing boundaries; otherwise wait for more chunks.
    for (const truncatedClose of ['</tool', '</']) {
      if (matchesCaseInsensitiveAt(buffer, i, truncatedClose) && buffer[i + truncatedClose.length] === '<') {
        const after = buffer.substring(i + truncatedClose.length);
        if (startsWithEnvironmentDetails(after)) {
          return { index: i, length: truncatedClose.length };
        }
      }
    }

    if (matchesCaseInsensitiveAt(buffer, i, '</tool')) {
      const next = buffer[i + '</tool'.length];
      if (next !== undefined && next !== '_' && next !== '>') {
        return { index: i, length: '</tool'.length };
      }
    }
  }
  return null;
}

function findRecoverableTailEndMatch(buffer: string): { index: number; length: number } | null {
  for (const name of getCloseNames()) {
    const tag = `</${name}>`;
    const index = buffer.toLowerCase().lastIndexOf(tag.toLowerCase());
    if (index !== -1 && index + tag.length === buffer.length) {
      return { index, length: tag.length };
    }
  }
  return null;
}

function startsWithEnvironmentDetails(buffer: string): boolean {
  // Match an <environment_details> block at the start of the buffer. Editor clients
  // sometimes glue a stray/truncated closing fragment right before it (e.g.
  // "</environment_details>", "</tool</environment_details>", "</<environment_details>"),
  // so tolerate an optional leading "</...tool..." / "</" fragment before the tag.
  return /^\s*(?:<\/(?:tool[a-z_]*)?<?\/?)?\s*<?\/?environment_details\b/i.test(buffer);
}



// ─── Partial Tag Detection ─────────────────────────────────────────────────────

const TOOL_START_LITERAL = TOOL_CALL_OPEN;

function findPartialToolOpenIndex(buffer: string): number {
  const bufLen = buffer.length;
  const openNames = getOpenNames();

  // Hold back a trailing `<` that is a prefix of some open tag with no `>` after
  // it (a chunk boundary split the tag). We check every accepted open name.
  for (let i = bufLen - 1; i >= 0; i--) {
    if (buffer[i] !== '<') continue;
    const tail = buffer.substring(i);
    if (tail.includes('>')) continue; // completed/closed tag — not a partial
    let isPrefix = false;
    for (const name of openNames) {
      const full = `<${name}`;
      if (full.startsWith(tail) || tail.startsWith(full)) {
        isPrefix = true;
        break;
      }
    }
    if (isPrefix) return i;
  }

  // Fallback for a `<` followed by partial name chars that don't yet match a full
  // open tag (e.g. chunk ends with `<qpx`). Only hold when there is no `>` ahead.
  const m = buffer.slice(Math.max(0, bufLen - 40)).match(/<[a-zA-Z_][\w-]*$/);
  if (m && m.index !== undefined && buffer.indexOf('>', bufLen - 40 + m.index) === -1) {
    return bufLen - 40 + m.index;
  }
  return -1;
}

// ─── StreamingToolParser ───────────────────────────────────────────────────────

export class StreamingToolParser {
  private buffer = '';
  private insideTool = false;
  private currentOpenTag = TOOL_START_LITERAL;
  private emittedToolCallCount = 0;
  private malformedToolCallCount = 0;
  private pendingLeadIn = '';
  private tools: FunctionToolDefinition[] = [];

  /**
   * @param tools - Optional array of tool definitions for name inference
   */
  constructor(tools: FunctionToolDefinition[] = [], private readonly rejectMalformed = false) {
    this.tools = tools;
  }

  /**
   * Update the tools list (e.g. if received after construction).
   */
  setTools(tools: FunctionToolDefinition[]): void {
    this.tools = tools;
  }

  feed(chunk: string): ParserResult {
    this.buffer += chunk;
    const result: ParserResult = { text: '', toolCalls: [] };

    while (this.buffer.length > 0) {
      if (!this.insideTool) {
        if (this.buffer.indexOf('<') === -1) {
          if (this.emittedToolCallCount === 0) result.text += sanitizeStrayCloses(this.buffer);
          this.buffer = '';
          break;
        }
        const match = findToolOpen(this.buffer);
        if (match) {
          // Text before the tool call tag
          const textBefore = sanitizeStrayCloses(this.buffer.substring(0, match.index));
          result.text += textBefore;
          this.insideTool = true;
          this.currentOpenTag = match.tag;
          this.buffer = this.buffer.substring(match.index + match.length);
          continue;
        } else {
          // No full open tag found. Check for partial at end.
          const partialIdx = findPartialToolOpenIndex(this.buffer);
          const flushIndex = partialIdx === -1 ? this.buffer.length : partialIdx;
          if (flushIndex > 0) {
             const textToEmit = sanitizeStrayCloses(this.buffer.substring(0, flushIndex));
            // Only emit as content if no tool calls have been emitted yet
            if (this.emittedToolCallCount === 0) {
              result.text += textToEmit;
            }
            this.buffer = this.buffer.substring(flushIndex);
          }
          break;
        }
       } else {
        const endMatch = findToolEndMatch(this.buffer) || findRecoverableTailEndMatch(this.buffer);
         if (endMatch) {
          const content = this.buffer.substring(0, endMatch.index);
          this.buffer = this.buffer.substring(endMatch.index + endMatch.length);
          this.processToolContent(content, result);
          this.insideTool = false;
          this.currentOpenTag = TOOL_START_LITERAL;
          if (this.emittedToolCallCount > 0 && startsWithEnvironmentDetails(this.buffer)) {
            this.buffer = '';
            break;
          }
          if (this.buffer.length > 0) {
            const nextMatch = findToolOpen(this.buffer);
            if (nextMatch) {
              const lead = sanitizeStrayCloses(this.buffer.substring(0, nextMatch.index));
              if (lead.trim().length > 0) result.text += lead;
              this.insideTool = true;
              this.currentOpenTag = nextMatch.tag;
              this.buffer = this.buffer.substring(nextMatch.index + nextMatch.length);
            } else {
              const partialIdx = findPartialToolOpenIndex(this.buffer);
              const flushIdx = partialIdx === -1 ? this.buffer.length : partialIdx;
              const tail = sanitizeStrayCloses(this.buffer.substring(0, flushIdx));
              if (tail.trim().length > 0) result.text += tail;
              this.buffer = this.buffer.substring(flushIdx);
            }
          }
        } else {
          break;
        }
      }
    }

    return result;
  }

  flush(): ParserResult {
    const result: ParserResult = { text: '', toolCalls: [] };
    if (!this.buffer && !this.pendingLeadIn) return result;

    if (this.insideTool) {
      const trimmed = this.buffer.trim();
      if (trimmed.length > 0) {
        const recovered = this.recoverAllToolCalls(trimmed);
        if (recovered.length > 0) {
          for (const tc of recovered) {
            result.toolCalls.push(tc);
            this.emittedToolCallCount++;
          }
        } else {
          throttledWarn('unrecoverable', (n) =>
            logger.warn(`[parser] Dropping unrecoverable unclosed tool call at end of stream (${n} total)`)
          );
          result.text += this.pendingLeadIn;
          this.malformedToolCallCount++;
          if (!this.rejectMalformed) result.text += this.currentOpenTag + this.buffer + closeTagFor(this.currentOpenTag);
        }      } else {
        this.malformedToolCallCount++;
        result.text += this.pendingLeadIn;
      }
    } else {
      result.text += sanitizeStrayCloses(this.buffer);
    }

    this.buffer = '';
    this.pendingLeadIn = '';
    this.insideTool = false;
    this.currentOpenTag = TOOL_START_LITERAL;
    return result;
  }

  hasMalformedToolCalls(): boolean { return this.malformedToolCallCount > 0; }

  getEmittedToolCallCount(): number {
    return this.emittedToolCallCount;
  }

  isInsideTool(): boolean {
    return this.insideTool;
  }

  // ─── Internal Methods ──────────────────────────────────────────────────────

  private processToolContent(content: string, result: ParserResult): void {
    let t = content.trim();
    if (!t) {
      this.malformedToolCallCount++;
      logger.debug('[parser] Dropping empty tool call block');
      if (this.emittedToolCallCount === 0 && this.pendingLeadIn.trim().length > 0) {
        result.text += this.pendingLeadIn;
      }
      this.pendingLeadIn = '';
      return;
    }

    t = unescapeDoubleEscaped(t);

    const shorthandParsed = parseFunctionShorthandToolCall(t);
    if (shorthandParsed) {
      result.toolCalls.push({
        id: `call_${crypto.randomUUID()}`,
        name: shorthandParsed.name,
        arguments: shorthandParsed.arguments,
      });
      this.emittedToolCallCount++;
      this.pendingLeadIn = '';
      return;
    }

    const xmlParsed = parseXmlParameterToolCall(t, this.currentOpenTag, this.tools);
    if (xmlParsed) {
      result.toolCalls.push({
        id: `call_${crypto.randomUUID()}`,
        name: xmlParsed.name,
        arguments: xmlParsed.arguments,
      });
      this.emittedToolCallCount++;
      this.pendingLeadIn = '';
      return;
    }

    // 2) Try JSON array format
    if (t.startsWith('[')) {
      try {
        const arr = JSON.parse(t);
        if (!Array.isArray(arr) || arr.length === 0) this.malformedToolCallCount++;
        for (const item of arr) {
          const tc = this.parseToolCall(item);
          if (tc) {
            result.toolCalls.push(tc);
            this.emittedToolCallCount++;
          } else this.malformedToolCallCount++;
        }
        this.pendingLeadIn = '';
        return;
      } catch {
        // Fall through to JSON object parsing
      }
    }

    // 3) Try JSON object format (single or multiple)
    if (t.startsWith('{') || t.includes('"name"') || t.includes('tool_calls') || t.includes('function_call')) {
      const calls = this.parseToolContent(t);
      if (calls.length > 0) {
        for (const tc of calls) {
          if (!tc.name || tc.name === '') {
            const attrName = extractToolName(this.currentOpenTag, t);
            if (attrName) tc.name = attrName;
          }
          if (tc.name) {
            result.toolCalls.push(tc);
            this.emittedToolCallCount++;
          } else this.malformedToolCallCount++;
        }
        this.pendingLeadIn = '';
        return;
      }
    }

    // 4) Tool call is malformed and unrecoverable.
    this.malformedToolCallCount++;
    metrics.increment('toolcalls.malformed');
    throttledWarn('malformed', (n) =>
      logger.warn(`[parser] Dropping malformed tool call block (${n} total)`, {
        contentPreview: t.substring(0, 500),
        hasName: t.includes('"name"') || t.includes('"tool"') || t.includes('tool_name'),
        hasArgs: t.includes('"arguments"') || t.includes('"args"') || t.includes('"parameters"') || t.includes('"input"'),
        first100Chars: t.substring(0, 100)
      })
    );
    result.text += this.pendingLeadIn;
    if (!this.rejectMalformed) result.text += this.currentOpenTag + content + closeTagFor(this.currentOpenTag);
    this.pendingLeadIn = '';
  }

  private tryRecoverToolCall(block: string): ParsedToolCall | null {
    const all = this.recoverAllToolCalls(block);
    return all.length > 0 ? all[0] : null;
  }

  /**
   * Recovers every tool call embedded in a (possibly unclosed) block. Unlike
   * `tryRecoverToolCall`, this handles the provider emitting multiple JSON
   * objects inside a single unterminated `<tool_call >` block — each top-level
   * `{...}` is treated as an independent tool call.
   */
  private recoverAllToolCalls(block: string): ParsedToolCall[] {
    const unescaped = unescapeDoubleEscaped(block);
    const out: ParsedToolCall[] = [];

    const shorthandParsed = parseFunctionShorthandToolCall(unescaped);
    if (shorthandParsed) {
      return [{
        id: `call_${crypto.randomUUID()}`,
        name: shorthandParsed.name,
        arguments: shorthandParsed.arguments,
      }];
    }

    const xmlParsed = parseXmlParameterToolCall(unescaped, this.currentOpenTag, this.tools);
    if (xmlParsed) {
      return [{
        id: `call_${crypto.randomUUID()}`,
        name: xmlParsed.name,
        arguments: xmlParsed.arguments,
      }];
    }

    const recovered = parseRecoverableXmlToolCall(unescaped, this.currentOpenTag, this.tools);
    if (recovered) {
      return [{
        id: `call_${crypto.randomUUID()}`,
        name: recovered.name,
        arguments: recovered.arguments,
      }];
    }

    const attrName = extractToolName(this.currentOpenTag, unescaped);
    for (const tc of this.parseToolContent(unescaped)) {
      if (attrName && !tc.name) tc.name = attrName;
      if (tc.name) out.push(tc);
    }

    return out;
  }

  private parseToolContent(str: string): ParsedToolCall[] {
    const calls: ParsedToolCall[] = [];
    
    // Try parsing as single JSON first
    try {
      const parsed = robustParseJSON(str);
      if (parsed && typeof parsed === 'object') {
        const tc = this.parseToolCall(parsed);
        if (tc) calls.push(tc);
      }
    } catch { /* ignore */ }

    for (const part of splitTopLevelJsonValues(str)) {
      try {
        const parsed = robustParseJSON(part);
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          const tc = this.parseToolCall(item);
          if (tc && !calls.some(c => c.id === tc.id || (c.name === tc.name && JSON.stringify(c.arguments) === JSON.stringify(tc.arguments)))) {
            calls.push(tc);
          }
        }
      } catch { /* ignore */ }
    }
    
    // Always try line-by-line parsing for multi-JSON content (independent of single parse)
    if (str.includes('\n')) {
      const lines = str.split('\n').map(l => l.trim()).filter(l => l.startsWith('{') && l.endsWith('}'));
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === 'object') {
            const tc = this.parseToolCall(parsed);
            if (tc && !calls.some(c => c.name === tc.name && JSON.stringify(c.arguments) === JSON.stringify(tc.arguments))) {
              calls.push(tc);
            }
          }
        } catch { /* ignore */ }
      }
    }
    
    return calls;
  }

  private parseToolCall(parsed: any): ParsedToolCall | null {
    parsed = normalizeToolCallObject(parsed);
    if (!parsed || typeof parsed !== 'object') return null;

    if (Array.isArray(parsed.tool_calls)) {
      return this.parseToolCall(parsed.tool_calls[0]);
    }

    if (parsed.function_call) {
      parsed = {
        id: parsed.id,
        name: parsed.function_call.name,
        arguments: parsed.function_call.arguments || {},
      };
    }
    
    const name = parsed.name || parsed.function?.name || parsed.tool_name || parsed.tool;
    if (!name || typeof name !== 'string' || name.length === 0) return null;
    
    let args = parsed.arguments || parsed.function?.arguments || parsed.args || parsed.parameters || parsed.input || {};
    if (typeof args === 'string') {
      try { args = robustParseJSON(args) || JSON.parse(args); }
      catch { args = {}; }
    }
    if (typeof args !== 'object' || args === null) args = {};

    return {
      id: parsed.id || parsed.tool_call_id || `call_${crypto.randomUUID()}`,
      name,
      arguments: args,
    };
  }
}
