/**
 * A small, dependency-free arithmetic evaluator (shunting-yard).
 * Deliberately not `eval` — the expression comes from a language model.
 */
const OPERATORS = {
  '+': { precedence: 1, assoc: 'left', apply: (a, b) => a + b },
  '-': { precedence: 1, assoc: 'left', apply: (a, b) => a - b },
  '*': { precedence: 2, assoc: 'left', apply: (a, b) => a * b },
  '/': { precedence: 2, assoc: 'left', apply: (a, b) => a / b },
  '%': { precedence: 2, assoc: 'left', apply: (a, b) => a % b },
  '^': { precedence: 3, assoc: 'right', apply: (a, b) => a ** b },
};

const FUNCTIONS = {
  sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor,
  ceil: Math.ceil, log: Math.log, log10: Math.log10, sin: Math.sin,
  cos: Math.cos, tan: Math.tan, min: Math.min, max: Math.max,
};

const CONSTANTS = { pi: Math.PI, e: Math.E };

function tokenize(input) {
  const tokens = [];
  const src = String(input).replace(/,/g, '').toLowerCase();
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (/[0-9.]/.test(ch)) {
      let num = '';
      while (i < src.length && /[0-9._]/.test(src[i])) num += src[i++];
      const value = Number(num.replace(/_/g, ''));
      if (Number.isNaN(value)) throw new Error(`Not a number: ${num}`);
      tokens.push({ type: 'number', value });
      continue;
    }
    if (/[a-z]/.test(ch)) {
      let word = '';
      while (i < src.length && /[a-z0-9]/.test(src[i])) word += src[i++];
      if (word in CONSTANTS) tokens.push({ type: 'number', value: CONSTANTS[word] });
      else if (word in FUNCTIONS) tokens.push({ type: 'function', value: word });
      else throw new Error(`Unknown symbol: ${word}`);
      continue;
    }
    if (ch in OPERATORS) {
      const prev = tokens[tokens.length - 1];
      const unary = ch === '-' && (!prev || prev.type === 'operator' || prev.value === '(');
      tokens.push(unary ? { type: 'unary', value: '-' } : { type: 'operator', value: ch });
      i += 1;
      continue;
    }
    if (ch === '(' || ch === ')') { tokens.push({ type: 'paren', value: ch }); i += 1; continue; }
    throw new Error(`Unexpected character: ${ch}`);
  }
  return tokens;
}

export function calculate(expression) {
  const tokens = tokenize(expression);
  const output = [];
  const ops = [];

  const popTo = (predicate) => {
    while (ops.length && predicate(ops[ops.length - 1])) output.push(ops.pop());
  };

  for (const token of tokens) {
    if (token.type === 'number') output.push(token);
    else if (token.type === 'function' || token.type === 'unary') ops.push(token);
    else if (token.type === 'operator') {
      const o1 = OPERATORS[token.value];
      popTo((top) => {
        if (top.type === 'unary' || top.type === 'function') return true;
        if (top.type !== 'operator') return false;
        const o2 = OPERATORS[top.value];
        return o2.precedence > o1.precedence || (o2.precedence === o1.precedence && o1.assoc === 'left');
      });
      ops.push(token);
    } else if (token.value === '(') ops.push(token);
    else {
      popTo((top) => top.value !== '(');
      if (!ops.length) throw new Error('Mismatched parentheses');
      ops.pop();
      if (ops.length && ops[ops.length - 1].type === 'function') output.push(ops.pop());
    }
  }
  while (ops.length) {
    const top = ops.pop();
    if (top.value === '(') throw new Error('Mismatched parentheses');
    output.push(top);
  }

  const stack = [];
  for (const token of output) {
    if (token.type === 'number') stack.push(token.value);
    else if (token.type === 'unary') stack.push(-stack.pop());
    else if (token.type === 'function') {
      const arg = stack.pop();
      if (arg === undefined) throw new Error(`Missing argument for ${token.value}`);
      stack.push(FUNCTIONS[token.value](arg));
    } else {
      const b = stack.pop();
      const a = stack.pop();
      if (a === undefined || b === undefined) throw new Error('Malformed expression');
      stack.push(OPERATORS[token.value].apply(a, b));
    }
  }
  if (stack.length !== 1 || !Number.isFinite(stack[0])) throw new Error('Malformed expression');
  return stack[0];
}
