export function parseSExpressions(text) {
  const tokens = text.match(/\(|\)|"(?:[^"]|"")*"|[^\s()]+/g) ?? [];
  let cursor = 0;
  const parse = () => {
    if (cursor >= tokens.length) throw new Error('truncated solver output');
    const token = tokens[cursor++];
    if (token === ')') throw new Error('unexpected closing parenthesis');
    if (token !== '(') return token;
    const items = [];
    while (tokens[cursor] !== ')') items.push(parse());
    cursor += 1;
    return items;
  };
  const expressions = [];
  while (cursor < tokens.length) expressions.push(parse());
  return expressions;
}

const render = (tree) => (Array.isArray(tree) ? `(${tree.map(render).join(' ')})` : tree);

// Every reachable counter is <= 40. Eight bits preserve integer semantics here.
export function finiteEncoding(source) {
  const ops = { '+': 'bvadd', '<=': 'bvule', '<': 'bvult', '>=': 'bvuge', '>': 'bvugt' };
  const convert = (tree) => {
    if (Array.isArray(tree)) return tree.map(convert);
    if (tree === 'Int') return ['_', 'BitVec', '8'];
    if (/^\d+$/.test(tree)) {
      if (Number(tree) > 255) throw new Error('model numeral overflows eight-bit encoding');
      return ['_', `bv${tree}`, '8'];
    }
    return ops[tree] ?? tree;
  };
  return source
    .split('\n')
    .map((line) => {
      if (line.startsWith('(set-logic ')) return '(set-logic QF_AUFBV)';
      if (!line.startsWith('(assert ') && !line.startsWith('(declare-const ')) return line;
      const [tree] = parseSExpressions(line);
      return render(convert(tree));
    })
    .join('\n');
}
