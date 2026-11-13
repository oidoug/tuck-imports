export interface ImportBlock {
  /** Offset of the first import statement. */
  start: number;
  /** Offset just past the last import statement. */
  end: number;
  count: number;
  /** False when the block starts with a `require()` declaration. */
  startsWithImport: boolean;
}

export interface FindOptions {
  includeRequire?: boolean;
  from?: number;
}

const IDENTIFIER = /[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*/uy;
const CLOSING: Record<string, string> = { '{': '}', '[': ']', '(': ')' };

class Scanner {
  pos: number;

  constructor(readonly text: string, start: number) {
    this.pos = start;
  }

  get eof(): boolean {
    return this.pos >= this.text.length;
  }

  char(offset = 0): string | undefined {
    return this.text[this.pos + offset];
  }

  /** Skips whitespace and comments. Returns true if a line break was crossed. */
  skipTrivia(): boolean {
    const { text } = this;
    let newline = false;
    while (this.pos < text.length) {
      const c = text[this.pos];
      if (isLineBreak(c)) {
        newline = true;
        this.pos++;
      } else if (/\s/.test(c)) {
        this.pos++;
      } else if (c === '/' && text[this.pos + 1] === '/') {
        while (this.pos < text.length && !isLineBreak(text[this.pos])) this.pos++;
      } else if (c === '/' && text[this.pos + 1] === '*') {
        const close = text.indexOf('*/', this.pos + 2);
        const end = close === -1 ? text.length : close + 2;
        if (/[\n\r\u2028\u2029]/.test(text.slice(this.pos, end))) newline = true;
        this.pos = end;
      } else {
        break;
      }
    }
    return newline;
  }

  identifier(): string | undefined {
    IDENTIFIER.lastIndex = this.pos;
    const match = IDENTIFIER.exec(this.text);
    if (!match) return undefined;
    this.pos += match[0].length;
    return match[0];
  }

  string(): boolean {
    const quote = this.char();
    if (quote !== '"' && quote !== "'") return false;
    for (let i = this.pos + 1; i < this.text.length; i++) {
      const c = this.text[i];
      if (c === '\\') i++;
      else if (c === quote) {
        this.pos = i + 1;
        return true;
      } else if (isLineBreak(c)) return false;
    }
    return false;
  }

  template(): boolean {
    this.pos++;
    while (this.pos < this.text.length) {
      const c = this.text[this.pos];
      if (c === '\\') this.pos += 2;
      else if (c === '`') {
        this.pos++;
        return true;
      } else if (c === '$' && this.text[this.pos + 1] === '{') {
        this.pos++;
        if (!this.balanced()) return false;
      } else this.pos++;
    }
    return false;
  }

  /** Skips a bracketed group, starting at the opening bracket. */
  balanced(): boolean {
    const open = this.char();
    const close = open && CLOSING[open];
    if (!close) return false;
    let depth = 0;
    while (true) {
      this.skipTrivia();
      const c = this.char();
      if (c === undefined) return false;
      if (c === '"' || c === "'") {
        if (!this.string()) return false;
        continue;
      }
      if (c === '`') {
        if (!this.template()) return false;
        continue;
      }
      if (c === open) depth++;
      else if (c === close && --depth === 0) {
        this.pos++;
        return true;
      }
      this.pos++;
    }
  }

  /** Consumes `ch` after optional trivia, or leaves the position untouched. */
  optional(ch: string): boolean {
    const start = this.pos;
    this.skipTrivia();
    if (this.char() === ch) {
      this.pos++;
      return true;
    }
    this.pos = start;
    return false;
  }

  /** Consumes a statement terminator: `;`, a line break, or end of input. */
  endStatement(): boolean {
    const start = this.pos;
    const newline = this.skipTrivia();
    if (this.char() === ';') {
      this.pos++;
      return true;
    }
    const ended = newline || this.eof;
    this.pos = start;
    return ended;
  }
}

function isLineBreak(c: string): boolean {
  return c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029';
}

function isQuote(c: string | undefined): boolean {
  return c === '"' || c === "'";
}

function parseImport(s: Scanner): boolean {
  if (s.identifier() !== 'import') return false;
  s.skipTrivia();
  const next = s.char();
  // Dynamic `import()` and `import.meta`
  if (next === '(' || next === '.') return false;
  if (isQuote(next)) return s.string() && finishImport(s);

  const names: string[] = [];
  let bindings = false;
  while (true) {
    s.skipTrivia();
    const c = s.char();
    if (c === '{') {
      if (!s.balanced()) return false;
      bindings = true;
    } else if (c === '*' || c === ',') {
      s.pos++;
      bindings = true;
    } else if (c === '=') {
      // `import x = require('y')` or `import x = A.B`
      const plain = names.length === 1 || (names.length === 2 && names[0] === 'type');
      if (bindings || !plain) return false;
      s.pos++;
      s.skipTrivia();
      const target = s.identifier();
      if (!target) return false;
      if (target === 'require') {
        s.skipTrivia();
        return s.char() === '(' && s.balanced() && s.endStatement();
      }
      while (s.optional('.')) {
        s.skipTrivia();
        if (!s.identifier()) return false;
      }
      return s.endStatement();
    } else {
      const name = s.identifier();
      if (!name) return false;
      if (name === 'from') {
        const afterFrom = s.pos;
        s.skipTrivia();
        if (isQuote(s.char())) return s.string() && finishImport(s);
        s.pos = afterFrom;
      }
      names.push(name);
    }
  }
}

function finishImport(s: Scanner): boolean {
  const start = s.pos;
  const newline = s.skipTrivia();
  const keyword = s.identifier();
  // Import attributes: `with { type: 'json' }`, or the older `assert { ... }`
  if (keyword === 'with' || (keyword === 'assert' && !newline)) {
    s.skipTrivia();
    if (s.char() === '{') {
      if (!s.balanced()) return false;
      s.optional(';');
      return true;
    }
  }
  s.pos = start;
  s.optional(';');
  return true;
}

function requireCall(s: Scanner): boolean {
  if (s.identifier() !== 'require') return false;
  s.skipTrivia();
  if (s.char() !== '(') return false;
  s.pos++;
  s.skipTrivia();
  if (!s.string()) return false;
  s.skipTrivia();
  if (s.char() !== ')') return false;
  s.pos++;
  return true;
}

function parseRequire(s: Scanner): boolean {
  const start = s.pos;
  const keyword = s.identifier();
  if (keyword === 'require') {
    s.pos = start;
    return requireCall(s) && s.endStatement();
  }
  if (keyword !== 'const' && keyword !== 'let' && keyword !== 'var') return false;

  do {
    s.skipTrivia();
    const c = s.char();
    if (c === '{' || c === '[') {
      if (!s.balanced()) return false;
    } else if (!s.identifier()) return false;
    s.skipTrivia();
    if (s.char() !== '=' || s.char(1) === '=') return false;
    s.pos++;
    s.skipTrivia();
    if (!requireCall(s)) return false;
    // `require('x').default`
    while (s.optional('.')) {
      s.skipTrivia();
      if (!s.identifier()) return false;
    }
  } while (s.optional(','));

  return s.endStatement();
}

function parseDirective(s: Scanner): boolean {
  return s.string() && s.endStatement();
}

export function findImportBlock(text: string, options: FindOptions = {}): ImportBlock | undefined {
  const includeRequire = options.includeRequire ?? true;
  const s = new Scanner(text, options.from ?? 0);
  if (s.pos === 0 && text.startsWith('#!')) {
    while (!s.eof && !isLineBreak(text[s.pos])) s.pos++;
  }

  let block: ImportBlock | undefined;
  while (true) {
    s.skipTrivia();
    if (s.eof) break;
    const start = s.pos;

    let isImport = parseImport(s);
    let isRequire = false;
    if (!isImport) {
      s.pos = start;
      isRequire = includeRequire && parseRequire(s);
    }
    if (!isImport && !isRequire) {
      s.pos = start;
      // 'use strict', 'use client', ...
      if (!block && parseDirective(s)) continue;
      break;
    }

    if (block) {
      block.end = s.pos;
      block.count++;
    } else {
      block = { start, end: s.pos, count: 1, startsWithImport: isImport };
    }
  }
  return block;
}

/** Where to start scanning for imports, or undefined if the file has no script section. */
export function scriptStart(text: string, languageId: string): number | undefined {
  if (languageId === 'vue' || languageId === 'svelte') {
    const tag = /<script\b[^>]*>/i.exec(text);
    return tag ? tag.index + tag[0].length : undefined;
  }
  if (languageId === 'astro') {
    const fence = /^\s*---[ \t]*\r?\n/.exec(text);
    return fence ? fence[0].length : undefined;
  }
  return 0;
}
