/**
 * Utility functions for browser operations
 */

type EvaluateFunction = (...args: never[]) => unknown;

function describeJsonError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Serialize a function-form page.evaluate call for CDP Runtime.evaluate.
 *
 * Functions execute in the browser page context, so they cannot close over
 * Node-side variables. Pass external values as JSON-serializable args instead.
 */
export function serializeFunctionForEval(fn: EvaluateFunction, args: readonly unknown[] = []): string {
  const source = fn.toString().trim();
  const isFunctionSource = /^(async\s+)?function[\s(]/.test(source)
    || /^(async\s*)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(source);
  if (!isFunctionSource || source.includes('[native code]')) {
    throw new Error('page.evaluate(fn) requires a serializable arrow/function expression');
  }

  let serializedArgs: string;
  try {
    serializedArgs = JSON.stringify(args);
  } catch (err) {
    throw new Error(`page.evaluate arguments must be JSON-serializable: ${describeJsonError(err)}`);
  }
  if (serializedArgs === undefined) {
    throw new Error('page.evaluate arguments must be JSON-serializable');
  }

  return `(${source})(...${serializedArgs})`;
}

/**
 * Wrap JS code for CDP Runtime.evaluate:
 * - Already an IIFE `(...)()` → send as-is
 * - Arrow/function literal → wrap as IIFE `(code)()`
 * - `new Promise(...)` or raw expression → send as-is (expression)
 */
export function wrapForEval(js: string): string {
  if (typeof js !== 'string') return 'undefined';
  const code = js.trim();
  if (!code) return 'undefined';

  // Already an IIFE: `(async () => { ... })()` or `(function() {...})()`
  if (/^\([\s\S]*\)\s*\(.*\)\s*$/.test(code)) return code;

  // Arrow function: `() => ...` or `async () => ...`
  if (/^(async\s+)?(\([^)]*\)|[A-Za-z_]\w*)\s*=>/.test(code)) return `(${code})()`;

  // Function declaration: `function ...` or `async function ...`
  if (/^(async\s+)?function[\s(]/.test(code)) return `(${code})()`;

  // Everything else: bare expression, `new Promise(...)`, etc. → evaluate directly
  return code;
}

/**
 * True when the code contains `await` at nesting depth 0 — outside every
 * bracket, string, template and comment. Top-level await is only legal in
 * modules, so a plain Runtime.evaluate rejects it with a SyntaxError;
 * callers pass `replMode: true` in that case (the same mechanism the DevTools
 * console uses) to make the evaluation accept it and return the script's
 * completion value. Misses only degrade to today's SyntaxError.
 */
export function hasTopLevelAwait(js: string): boolean {
  const n = js.length;
  let i = 0;
  let depth = 0;
  while (i < n) {
    const c = js[i];
    if (c === '/' && js[i + 1] === '/') {
      while (i < n && js[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && js[i + 1] === '*') {
      i += 2;
      while (i < n && !(js[i] === '*' && js[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      i++;
      while (i < n && js[i] !== c) {
        if (js[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === '`') {
      i++;
      while (i < n && js[i] !== '`') {
        if (js[i] === '\\') {
          i += 2;
          continue;
        }
        if (js[i] === '$' && js[i + 1] === '{') {
          // Interpolation body is code: skip to its matching brace.
          let braces = 1;
          i += 2;
          while (i < n && braces > 0) {
            if (js[i] === '{') braces++;
            else if (js[i] === '}') braces--;
            i++;
          }
          continue;
        }
        i++;
      }
      i++;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      depth++;
      i++;
      continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(js[j])) j++;
      if (js.slice(i, j) === 'await' && depth === 0) return true;
      i = j;
      continue;
    }
    i++;
  }
  return false;
}

export function buildEvaluateExpression(input: string | EvaluateFunction, args: readonly unknown[] = []): string {
  if (typeof input === 'function') {
    return serializeFunctionForEval(input, args);
  }
  if (args.length > 0) {
    throw new Error('page.evaluate string input does not accept args; use page.evaluate(fn, ...args) instead');
  }
  return wrapForEval(input);
}
