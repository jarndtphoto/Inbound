import ts from 'typescript';
import { readFile, readdir } from 'node:fs/promises';

const forbiddenNames = new Set(['fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource', 'Worker', 'SharedWorker', 'Function', 'eval', 'require', 'module', 'global', 'globalThis', 'Deno', 'Bun', 'importScripts', 'syncBuiltinESMExports']);
const forbiddenCalls = new Set(['sendBeacon', 'getBuiltinModule', 'createRequire', 'exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork', 'connect', 'createConnection', 'createSocket', 'constructor']);
const metadataUrls = new Set(['https://chatgpt.com', 'https://json-schema.org/draft/2020-12/schema', 'http://json-schema.org/draft-07/schema#', 'http://json-schema.org/draft-04/schema#']);
/** @param {string} message */
const fail = message => { throw new Error(`Fixture static isolation: ${message}`); };

/** Inspect application JS, not the Vercel host's inbound HTTP transport.
 * @param {string} code
 */
export function assertFixtureApplication(code, { widget = false } = {}) {
  const tree = ts.createSourceFile('fixture.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (/** @type {ts.SourceFile & {parseDiagnostics: readonly ts.Diagnostic[]}} */ (tree).parseDiagnostics.length) fail('invalid application JavaScript');
  /** @param {ts.Node} node */
  const visit = node => {
    if (ts.isImportDeclaration(node)) {
      const bindings = node.importClause?.namedBindings;
      if (widget || !ts.isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text !== 'node:crypto' || node.importClause?.name || !bindings || !ts.isNamedImports(bindings) || bindings.elements.some(e => (e.propertyName ?? e.name).text !== 'randomBytes')) fail('forbidden module import');
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) fail('external re-export');
    if (node.kind === ts.SyntaxKind.ImportKeyword) fail('dynamic import');
    if (ts.isIdentifier(node) && forbiddenNames.has(node.text)) {
      // The self-contained widget has one local-only fallback to its own /mcp.
      const localWidgetRead = widget && node.text === 'fetch' && ts.isCallExpression(node.parent) && node.parent.expression === node && node.parent.arguments[0] && ts.isStringLiteral(node.parent.arguments[0]) && node.parent.arguments[0].text === '/mcp';
      if (!localWidgetRead) fail(`forbidden capability ${node.text}`);
    }
    if (ts.isIdentifier(node) && node.text === 'process' && !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node && node.parent.name.text === 'env')) fail('process capability beyond environment checks');
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = node.expression;
      const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isElementAccessExpression(callee) && ts.isStringLiteral(callee.argumentExpression) ? callee.argumentExpression.text : null;
      if (name && forbiddenCalls.has(name)) fail(`forbidden call ${name}`);
    }
    if (ts.isStringLiteralLike(node)) {
      const value = node.text;
      if (/(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?):\/\/|-----BEGIN[^\n]*PRIVATE KEY|\bBearer\s+[A-Za-z0-9._-]{12,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/i.test(value)) fail('credential or database connection string');
      for (const match of value.matchAll(/https?:\/\/[^\s"'<>`\\)]+/g)) {
        if (!metadataUrls.has(match[0])) fail('unapproved endpoint URL');
      }
      // Inspect embedded browser code separately from the inbound server.
      if (!widget && value.includes('<script')) {
        for (const match of value.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) assertFixtureApplication(match[1], { widget: true });
        if (/<script\b[^>]*\bsrc\s*=|\b(?:src|href)\s*=\s*["']https?:/i.test(value)) fail('external UI asset');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
}

/** @param {string} directory */
export async function assertFixturePayload(directory, { allowAudit = false } = {}) {
  /** @type {string[]} */
  const paths = [];
  /** @param {string} path */
  const visit = async (path, prefix = '') => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) { if (name !== 'api') fail('unapproved deployment directory'); await visit(`${path}/${entry.name}`, `${name}/`); }
      else if (entry.isFile()) paths.push(name);
      else fail('nonregular deployment entry');
    }
  };
  await visit(directory);
  const expected = ['api/mcp.js', 'package.json', 'vercel.json', ...(allowAudit && paths.includes('audit.json') ? ['audit.json'] : [])].sort();
  if (JSON.stringify(paths.sort()) !== JSON.stringify(expected)) fail('deployment must contain exactly the approved three files');
  const pkg = JSON.parse(await readFile(`${directory}/package.json`, 'utf8'));
  if (JSON.stringify(pkg) !== JSON.stringify({ name: 'inbound-live-fixture-preview', private: true, type: 'module', engines: { node: '22.x' } })) fail('unexpected package configuration');
  const config = JSON.parse(await readFile(`${directory}/vercel.json`, 'utf8'));
  if (JSON.stringify(config) !== JSON.stringify({ version: 2, rewrites: [{ source: '/mcp', destination: '/api/mcp' }, { source: '/widget', destination: '/api/mcp' }, { source: '/', destination: '/api/mcp' }], functions: { 'api/mcp.js': { maxDuration: 10 } } })) fail('unexpected deployment configuration');
  assertFixtureApplication(await readFile(`${directory}/api/mcp.js`, 'utf8'));
  return { fixtureOnly: true, files: paths.filter(p => p !== 'audit.json'), externalImports: ['node:crypto (randomBytes only)'], safety: 'static-isolation' };
}
