import { StudioError } from './ops'

// A small, closed expression language for video parameters. Storyboards are
// project data that agents and scripts write, so expressions are parsed with
// this grammar and compiled to closures; nothing is ever passed to eval.
//
// Grammar, lowest precedence first:
//   ternary  = or [ "?" ternary ":" ternary ] | or "if" or "else" ternary
//   or       = and { ("||" | "or") and }
//   and      = not { ("&&" | "and") not }
//   not      = ("!" | "not") not | compare
//   compare  = sum [ ("<" | "<=" | ">" | ">=" | "==" | "!=") sum ]
//   sum      = product { ("+" | "-") product }
//   product  = unary { ("*" | "/" | "%") unary }
//   unary    = ("-" | "+") unary | power
//   power    = atom [ "**" unary ]
//   atom     = number | name | name "(" args ")" | "(" ternary ")"

export type ExprScope = Readonly<Record<string, number>>
export type CompiledExpr = (scope: ExprScope) => number

/** Values an expression can read, with what each one means. */
export const VIDEO_VARIABLES: Readonly<Record<string, string>> = {
  t: 'Seconds since the song started.',
  L: 'Seconds since the scene started.',
  x: 'Progress through the scene, 0 to 1.',
  len: 'Scene length in seconds.',
  songLen: 'Song length in seconds.',
  beat: 'Beats since the song started.',
  bar: 'Bars since the song started.',
  BEAT: 'Seconds per beat.',
  BAR: 'Seconds per bar.',
  kick: 'Kick pulse, 1 on each hit and decaying to 0.',
  snare: 'Snare and clap pulse.',
  hat: 'Hi-hat pulse.',
  kt: 'Seconds since the last kick.',
  st: 'Seconds since the last snare.',
  sub: 'Sub band envelope (20 to 60 Hz), about 0 to 1.',
  bass: 'Bass band envelope (60 to 250 Hz).',
  mid: 'Mid band envelope (250 Hz to 2 kHz).',
  harsh: 'Upper-mid band envelope (2 to 6 kHz).',
  air: 'Air band envelope (6 to 20 kHz).',
  rms: 'Overall level envelope.',
  hatEnv: 'High-frequency onset envelope from the mix.',
  rise: 'Progress through the current riser, 0 to 1; 0 outside risers.',
  rstrobe: 'A strobe that speeds up through the current riser; 1 outside risers.',
  toImpact: 'Seconds until the next impact.',
  sinceImpact: 'Seconds since the last impact.',
  cut: 'Number of cut events so far in the scene.',
  cutT: 'Seconds since the last cut event in the scene.',
  pi: 'π.',
}

const smooth = (a: number, b: number, v: number) => {
  const k = Math.min(1, Math.max(0, (v - a) / (b - a)))
  return k * k * (3 - 2 * k)
}

/** Functions an expression can call, with their allowed argument counts. */
export const VIDEO_FUNCTIONS: Readonly<Record<string, { args: [number, number]; fn: (...v: number[]) => number }>> = {
  sin: { args: [1, 1], fn: Math.sin },
  cos: { args: [1, 1], fn: Math.cos },
  tan: { args: [1, 1], fn: Math.tan },
  exp: { args: [1, 1], fn: Math.exp },
  log: { args: [1, 1], fn: Math.log },
  sqrt: { args: [1, 1], fn: Math.sqrt },
  abs: { args: [1, 1], fn: Math.abs },
  floor: { args: [1, 1], fn: Math.floor },
  round: { args: [1, 1], fn: Math.round },
  fract: { args: [1, 1], fn: (v) => v - Math.floor(v) },
  min: { args: [2, 8], fn: Math.min },
  max: { args: [2, 8], fn: Math.max },
  pow: { args: [2, 2], fn: Math.pow },
  step: { args: [2, 2], fn: (edge, v) => (v >= edge ? 1 : 0) },
  clamp: { args: [1, 3], fn: (v, a = 0, b = 1) => Math.min(Math.max(v, a), b) },
  mix: { args: [3, 3], fn: (a, b, k) => a + (b - a) * k },
  smooth: { args: [3, 3], fn: smooth },
}

type Token = { kind: 'num'; value: number; at: number } | { kind: 'name'; value: string; at: number } | { kind: 'op'; value: string; at: number } | { kind: 'end'; at: number }

const OPERATORS = ['**', '<=', '>=', '==', '!=', '&&', '||', '+', '-', '*', '/', '%', '<', '>', '!', '?', ':', '(', ')', ',']
const MAX_LENGTH = 400

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    if (/\s/.test(ch)) {
      i += 1
      continue
    }
    const number = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(source.slice(i))
    if (number) {
      tokens.push({ kind: 'num', value: Number(number[0]), at: i })
      i += number[0].length
      continue
    }
    const name = /^[A-Za-z_]\w*/.exec(source.slice(i))
    if (name) {
      tokens.push({ kind: 'name', value: name[0], at: i })
      i += name[0].length
      continue
    }
    const op = OPERATORS.find((candidate) => source.startsWith(candidate, i))
    if (!op) throw new StudioError('invalid', `Unexpected "${ch}" at character ${i + 1} of "${source}".`)
    tokens.push({ kind: 'op', value: op, at: i })
    i += op.length
  }
  tokens.push({ kind: 'end', at: source.length })
  return tokens
}

const truthy = (v: number) => v !== 0 && !Number.isNaN(v)

function parse(source: string): CompiledExpr {
  if (source.length > MAX_LENGTH) throw new StudioError('invalid', `Expressions are limited to ${MAX_LENGTH} characters.`)
  const tokens = tokenize(source)
  let pos = 0
  const peek = () => tokens[pos]
  const isOp = (value: string) => peek().kind === 'op' && (peek() as { value: string }).value === value
  const isWord = (value: string) => peek().kind === 'name' && (peek() as { value: string }).value === value
  const fail = (why: string): never => {
    throw new StudioError('invalid', `${why} at character ${peek().at + 1} of "${source}".`)
  }
  const expect = (value: string) => {
    if (!isOp(value)) fail(`Expected "${value}"`)
    pos += 1
  }

  const ternary = (): CompiledExpr => {
    const cond = or()
    if (isOp('?')) {
      pos += 1
      const a = ternary()
      expect(':')
      const b = ternary()
      return (s) => (truthy(cond(s)) ? a(s) : b(s))
    }
    if (isWord('if')) {
      pos += 1
      const test = or()
      if (!isWord('else')) fail('Expected "else"')
      pos += 1
      const other = ternary()
      return (s) => (truthy(test(s)) ? cond(s) : other(s))
    }
    return cond
  }
  const or = (): CompiledExpr => {
    let left = and()
    while (isOp('||') || isWord('or')) {
      pos += 1
      const a = left
      const b = and()
      left = (s) => (truthy(a(s)) || truthy(b(s)) ? 1 : 0)
    }
    return left
  }
  const and = (): CompiledExpr => {
    let left = not()
    while (isOp('&&') || isWord('and')) {
      pos += 1
      const a = left
      const b = not()
      left = (s) => (truthy(a(s)) && truthy(b(s)) ? 1 : 0)
    }
    return left
  }
  const not = (): CompiledExpr => {
    if (isOp('!') || isWord('not')) {
      pos += 1
      const a = not()
      return (s) => (truthy(a(s)) ? 0 : 1)
    }
    return compare()
  }
  const compare = (): CompiledExpr => {
    const left = sum()
    const token = peek()
    if (token.kind !== 'op' || !['<', '<=', '>', '>=', '==', '!='].includes(token.value)) return left
    pos += 1
    const right = sum()
    switch (token.value) {
      case '<':
        return (s) => (left(s) < right(s) ? 1 : 0)
      case '<=':
        return (s) => (left(s) <= right(s) ? 1 : 0)
      case '>':
        return (s) => (left(s) > right(s) ? 1 : 0)
      case '>=':
        return (s) => (left(s) >= right(s) ? 1 : 0)
      case '==':
        return (s) => (left(s) === right(s) ? 1 : 0)
      default:
        return (s) => (left(s) !== right(s) ? 1 : 0)
    }
  }
  const sum = (): CompiledExpr => {
    let left = product()
    while (isOp('+') || isOp('-')) {
      const minus = isOp('-')
      pos += 1
      const a = left
      const b = product()
      left = minus ? (s) => a(s) - b(s) : (s) => a(s) + b(s)
    }
    return left
  }
  const product = (): CompiledExpr => {
    let left = unary()
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = (peek() as { value: string }).value
      pos += 1
      const a = left
      const b = unary()
      // Floored modulo, like Python and GLSL mod(), so negative time wraps cleanly.
      left = op === '*' ? (s) => a(s) * b(s) : op === '/' ? (s) => a(s) / b(s) : (s) => {
        const d = b(s)
        const v = a(s)
        return v - d * Math.floor(v / d)
      }
    }
    return left
  }
  const unary = (): CompiledExpr => {
    if (isOp('-')) {
      pos += 1
      const a = unary()
      return (s) => -a(s)
    }
    if (isOp('+')) {
      pos += 1
      return unary()
    }
    return power()
  }
  const power = (): CompiledExpr => {
    const base = atom()
    if (!isOp('**')) return base
    pos += 1
    const exponent = unary()
    return (s) => base(s) ** exponent(s)
  }
  const atom = (): CompiledExpr => {
    const token = peek()
    if (token.kind === 'num') {
      pos += 1
      const value = token.value
      return () => value
    }
    if (token.kind === 'op' && token.value === '(') {
      pos += 1
      const inner = ternary()
      expect(')')
      return inner
    }
    if (token.kind === 'name') {
      pos += 1
      if (isOp('(')) {
        if (!Object.hasOwn(VIDEO_FUNCTIONS, token.value)) fail(`Unknown function "${token.value}"`)
        const fn = VIDEO_FUNCTIONS[token.value]
        pos += 1
        const args: CompiledExpr[] = []
        if (!isOp(')')) {
          args.push(ternary())
          while (isOp(',')) {
            pos += 1
            args.push(ternary())
          }
        }
        expect(')')
        if (args.length < fn.args[0] || args.length > fn.args[1]) {
          throw new StudioError('invalid', `${token.value}() takes ${fn.args[0] === fn.args[1] ? fn.args[0] : `${fn.args[0]} to ${fn.args[1]}`} arguments in "${source}".`)
        }
        const call = fn.fn
        if (args.length === 1) {
          const [a] = args
          return (s) => call(a(s))
        }
        return (s) => call(...args.map((arg) => arg(s)))
      }
      if (token.value === 'pi') return () => Math.PI
      if (!Object.hasOwn(VIDEO_VARIABLES, token.value)) {
        throw new StudioError('invalid', `Unknown name "${token.value}" in "${source}". Expressions can read ${Object.keys(VIDEO_VARIABLES).join(', ')}.`)
      }
      const name = token.value
      return (s) => (Object.hasOwn(s, name) ? s[name] : 0)
    }
    return fail(token.kind === 'end' ? 'Unexpected end' : `Unexpected "${(token as { value: string }).value}"`)
  }

  const compiled = ternary()
  if (peek().kind !== 'end') fail('Unexpected text')
  return compiled
}

const cache = new Map<string, CompiledExpr>()

/** Compiles an expression to a function of the scope. Throws StudioError on bad syntax or unknown names. */
export function compileExpr(source: string): CompiledExpr {
  const hit = cache.get(source)
  if (hit) return hit
  const compiled = parse(source)
  if (cache.size > 2000) cache.clear()
  cache.set(source, compiled)
  return compiled
}

/** Compiles a number or an expression; non-finite results read as 0. */
export function compileScalar(value: number | string): CompiledExpr {
  if (typeof value === 'number') return () => value
  const fn = compileExpr(value)
  return (s) => {
    const v = fn(s)
    return Number.isFinite(v) ? v : 0
  }
}

/** Compiles a scalar or a vector whose parts may be numbers or expressions. */
export function compileValue(value: number | string | readonly (number | string)[]): (scope: ExprScope) => number[] {
  if (!Array.isArray(value)) {
    const fn = compileScalar(value as number | string)
    return (s) => [fn(s)]
  }
  const parts = value.map(compileScalar)
  if (value.every((part) => typeof part === 'number')) {
    const fixed = value as number[]
    return () => fixed
  }
  return (s) => parts.map((part) => part(s))
}
