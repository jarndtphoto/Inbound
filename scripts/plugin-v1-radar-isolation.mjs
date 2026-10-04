import ts from 'typescript';
import { readFile, readdir } from 'node:fs/promises';

// This checker is separate from the approved Part 3A.6 fixture checker. The
// proof deploys an actual Nearby engine with only injected invented inputs.
export const RADAR_PREVIEW_PACKAGE = {
  name: 'inbound-live-radar-preview', private: true, type: 'module', engines: { node: '22.x' },
};
export const RADAR_PREVIEW_CONFIG = {
  version: 2,
  rewrites: [
    { source: '/mcp', destination: '/api/mcp' },
    { source: '/widget', destination: '/api/mcp' },
    { source: '/', destination: '/api/mcp' },
  ],
  functions: { 'api/mcp.js': { maxDuration: 10 } },
};

const capabilities = new Set([
  'fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource', 'Worker', 'SharedWorker',
  'Function', 'eval', 'require', 'module', 'global', 'globalThis', 'Deno', 'Bun',
  'importScripts', 'syncBuiltinESMExports',
]);
const dangerousMembers = new Set([
  ...capabilities, 'sendBeacon', 'getBuiltinModule', 'createRequire', 'exec', 'execSync',
  'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork', 'connect',
  'createConnection', 'createSocket',
]);
const metadataUrls = new Set([
  'https://chatgpt.com', 'https://json-schema.org/draft/2020-12/schema',
  'http://json-schema.org/draft-07/schema#', 'http://json-schema.org/draft-04/schema#',
  // DOM namespace identifiers are not fetched resources or egress grants.
  'http://www.w3.org/2000/svg',
]);
const providerHost = /(?:^|[^a-z0-9])(?:[a-z0-9-]+\.)*(?:adsb\.fi|adsb\.lol|airplanes\.live|adsbdb\.com|flightradar24\.com|flightstats\.com|flightaware\.com|cirium\.com)(?:[^a-z0-9]|$)/i;
const secret = /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?):\/\/|-----BEGIN[^\n]*PRIVATE KEY|\bBearer\s+[A-Za-z0-9._-]{12,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}|\bgh[opsu]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/i;
const secretSetting = /DATABASE_URL|POSTGRES_URL|PGPASSWORD|(?:API|APP)[_-]?KEY|(?:API|AUTH|ACCESS|REFRESH)[_-]?TOKEN|(?:API|CLIENT)[_-]?SECRET|PASSWORD/i;
/** @param {string} message */
const fail = message => { throw new Error(`Radar proof static isolation: ${message}`); };

/** @param {ts.Expression} expression @returns {string | null} */
function staticText(expression) {
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isParenthesizedExpression(expression)) return staticText(expression.expression);
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticText(expression.left), right = staticText(expression.right);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

/** Inspect deployed application code, leaving the Vercel host's inbound HTTP
 * implementation outside the artifact. No package/network/DB runtime ships.
 * @param {string} code
 * @param {{widget?: boolean}} options
 */
export function assertRadarApplication(code, { widget = false } = {}) {
  const tree = ts.createSourceFile('radar-proof.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (/** @type {ts.SourceFile & {parseDiagnostics: readonly ts.Diagnostic[]}} */ (tree).parseDiagnostics.length) fail('invalid application JavaScript');
  /** @param {ts.Node} node @returns {ts.Node} */
  const scopeOf = node => {
    let scope = node.parent;
    while (scope && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
    return scope ?? tree;
  };
  /** @type {Map<ts.Node, Set<string>>} */
  const constructorAliases = new Map();
  /** @param {ts.Expression} node */
  const isConstructor = node => ts.isPropertyAccessExpression(node) ? node.name.text === 'constructor'
    : ts.isElementAccessExpression(node) && staticText(node.argumentExpression) === 'constructor';
  /** @param {ts.Node} node */
  const collect = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isConstructor(node.initializer)) {
      const scope = scopeOf(node), aliases = constructorAliases.get(scope) ?? new Set();
      aliases.add(node.name.text); constructorAliases.set(scope, aliases);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isIdentifier(node.left) && isConstructor(node.right)) {
      const scope = scopeOf(node), aliases = constructorAliases.get(scope) ?? new Set();
      aliases.add(node.left.text); constructorAliases.set(scope, aliases);
    }
    ts.forEachChild(node, collect);
  };
  collect(tree);
  /** @param {ts.Node} node */
  const visit = node => {
    if ((ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) && node.initializer) {
      const name = ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name) ? node.name.text : '';
      const value = staticText(node.initializer);
      if (secretSetting.test(name) && value) fail('embedded credential configuration');
    }
    if (ts.isImportDeclaration(node)) {
      const bindings = node.importClause?.namedBindings;
      if (widget || !ts.isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text !== 'node:crypto'
          || node.importClause?.name || !bindings || !ts.isNamedImports(bindings)
          || bindings.elements.some(element => !['randomBytes', 'randomUUID'].includes((element.propertyName ?? element.name).text))) fail('forbidden module import');
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) fail('external re-export');
    if (node.kind === ts.SyntaxKind.ImportKeyword) fail('dynamic import');
    if (ts.isIdentifier(node) && capabilities.has(node.text)) {
      const localWidgetRead = widget && node.text === 'fetch' && ts.isCallExpression(node.parent)
        && node.parent.expression === node && node.parent.arguments[0]
        && ts.isStringLiteralLike(node.parent.arguments[0]) && node.parent.arguments[0].text === '/mcp';
      if (!localWidgetRead) fail(`forbidden capability ${node.text}`);
    }
    if (ts.isIdentifier(node) && node.text === 'process'
        && !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node && node.parent.name.text === 'env')) fail('process capability beyond environment checks');
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = ts.isPropertyAccessExpression(node) ? node.name.text : staticText(node.argumentExpression);
      // Property access itself is rejected, not only a subsequent call: an
      // alias of window['fetch'] cannot evade this.
      if (name && dangerousMembers.has(name)) fail(`forbidden member ${name}`);
      // Zod inspects constructor/name to classify plain objects. Invoking an
      // object's constructor, or chaining to Function's constructor, is never
      // needed by this proof and would permit dynamic code generation.
      if (name === 'constructor' && (ts.isCallExpression(node.parent) || ts.isNewExpression(node.parent))
          && node.parent.expression === node) fail('dynamic constructor call');
      if (name === 'constructor' && isConstructor(node.expression)) fail('dynamic constructor chain');
    }
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && ts.isIdentifier(node.expression)) {
      let scope = scopeOf(node);
      while (scope) {
        if (constructorAliases.get(scope)?.has(node.expression.text)) fail('dynamic aliased constructor call');
        const parent = scopeOf(scope);
        if (parent === scope) break;
        scope = parent;
      }
    }
    if (ts.isStringLiteralLike(node)) {
      const value = node.text;
      // The build embeds the separately bundled widget IIFE as one server
      // string. Inspect its actual AST: regex-scanning source text would
      // mistake Zod's non-network IPv6 URL template for an endpoint literal.
      if (!widget && /^\(function\(\)\{/.test(value) && /\}\)\(\);?\s*$/.test(value)) {
        assertRadarApplication(value, { widget: true });
        return;
      }
      if (capabilities.has(value)) fail(`forbidden capability name ${value}`);
      // The dependency's plain-object check uses `'constructor' in object`;
      // computed/reflective retrieval of a constructor has no proof use.
      if (value === 'constructor' && !(ts.isBinaryExpression(node.parent)
          && node.parent.operatorToken.kind === ts.SyntaxKind.InKeyword && node.parent.left === node)) fail('dynamic constructor lookup');
      if (secret.test(value)) fail('credential or database connection string');
      if (providerHost.test(value)) fail('aviation provider host');
      for (const match of value.matchAll(/https?:\/\/[^\s"'<>`\\)]+/g)) {
        if (!metadataUrls.has(match[0])) fail('unapproved endpoint URL');
      }
      if (!widget && value.includes('<script')) {
        for (const match of value.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) assertRadarApplication(match[1], { widget: true });
      }
      if (/<script\b[^>]*\bsrc\s*=|\b(?:src|href)\s*=\s*["']\s*(?:[a-z][a-z0-9+.-]*:|\/\/)|\burl\(\s*["']?\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) fail('external UI asset');
    }
    if (ts.isCallExpression(node)) {
      for (const argument of node.arguments) {
        const value = staticText(argument);
        if (value && (capabilities.has(value) || value === 'constructor')) fail('dynamic capability lookup argument');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
}

/** @param {string} directory */
export async function assertRadarPayload(directory) {
  /** @type {string[]} */
  const paths = [];
  /** @param {string} path @param {string} prefix */
  const visit = async (path, prefix = '') => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) {
        if (name !== 'api') fail('unapproved deployment directory');
        await visit(`${path}/${entry.name}`, `${name}/`);
      } else if (entry.isFile()) paths.push(name);
      else fail('nonregular deployment entry');
    }
  };
  await visit(directory);
  const expected = ['api/mcp.js', 'package.json', 'vercel.json'];
  if (JSON.stringify(paths.sort()) !== JSON.stringify(expected)) fail('deployment must contain exactly the approved three files');
  const pkg = JSON.parse(await readFile(`${directory}/package.json`, 'utf8'));
  if (JSON.stringify(pkg) !== JSON.stringify(RADAR_PREVIEW_PACKAGE)) fail('unexpected package configuration');
  const config = JSON.parse(await readFile(`${directory}/vercel.json`, 'utf8'));
  if (JSON.stringify(config) !== JSON.stringify(RADAR_PREVIEW_CONFIG)) fail('unexpected deployment configuration');
  assertRadarApplication(await readFile(`${directory}/api/mcp.js`, 'utf8'));
  return {
    fakeAircraftOnly: true, files: paths,
    externalImports: ['node:crypto (randomBytes/randomUUID only)'],
    safety: 'static-isolation',
  };
}
