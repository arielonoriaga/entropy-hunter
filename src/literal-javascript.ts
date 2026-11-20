import ts from "typescript";

export interface LiteralText {
  value: string;
  from: number;
}

interface JavaScriptLiterals {
  comparisons: LiteralText[];
  sql: LiteralText[];
}

const COMPARISONS = new Set([
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);
const TYPE_TAGS = new Set(["undefined", "object", "boolean", "number", "bigint", "string", "symbol", "function"]);

function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression)
    || ts.isSatisfiesExpression(expression)) expression = expression.expression;
  return expression;
}

function staticText(expression: ts.Expression, file: ts.SourceFile): LiteralText | null {
  const value = unwrap(expression);
  if (!ts.isStringLiteral(value) && !ts.isNoSubstitutionTemplateLiteral(value)) return null;
  if (!value.text) return null;
  return { value: value.text, from: value.getStart(file) + 1 };
}

function comparedText(node: ts.BinaryExpression, file: ts.SourceFile): LiteralText[] {
  if (!COMPARISONS.has(node.operatorToken.kind)) return [];
  const hits: LiteralText[] = [];
  for (const [operand, other] of [[node.left, node.right], [node.right, node.left]]) {
    const literal = staticText(operand, file);
    if (!literal) continue;
    if (ts.isTypeOfExpression(unwrap(other)) && TYPE_TAGS.has(literal.value)) continue;
    hits.push(literal);
  }
  return hits;
}

const blank = (value: string) => value.replace(/[^\n]/g, " ");

function templateSql(node: ts.TemplateExpression, file: ts.SourceFile): LiteralText {
  const from = node.head.getStart(file) + 1;
  const end = node.end - 1;
  const chunks: string[] = [];
  let cursor = from;
  for (const part of [node.head, ...node.templateSpans.map(span => span.literal)]) {
    const start = part.getStart(file) + 1;
    const stop = part.end - (part.kind === ts.SyntaxKind.TemplateTail ? 1 : 2);
    chunks.push(blank(file.text.slice(cursor, start)), file.text.slice(start, stop));
    cursor = stop;
  }
  chunks.push(blank(file.text.slice(cursor, end)));
  return { from, value: chunks.join("") };
}

export function javascriptLiterals(path: string, source: string): JavaScriptLiterals {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false);
  const comparisons: LiteralText[] = [];
  const sql: LiteralText[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node)) comparisons.push(...comparedText(node, file));
    if (ts.isCaseClause(node)) {
      const value = staticText(node.expression, file);
      if (value) comparisons.push(value);
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const from = node.getStart(file) + 1;
      sql.push({ from, value: source.slice(from, node.end - 1) });
    }
    if (ts.isTemplateExpression(node)) sql.push(templateSql(node, file));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { comparisons, sql };
}
