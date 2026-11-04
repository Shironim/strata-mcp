import ts from 'typescript';
import { parseSfc } from './splitter';
import { inspectVueTreeInput } from './graph/vue-tree-input';
import type { ComponentContract } from '../types';

export interface ContractExpectation {
  props: Array<{ name: string; exists: boolean; type?: string; required?: boolean }>;
}

export function parseContractExpectation(value: unknown): ContractExpectation {
  const fail = () => { throw new Error('INVALID_CONTRACT_EXPECTATION: use { props: [{ name: "title", exists: false }, { name: "heading", exists: true, type: "string", required: true }] }. Only these fields are supported.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== 'props') || !Array.isArray(input.props) || input.props.length === 0) return fail();
  const names = new Set<string>();
  const props = input.props.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return fail();
    const check = item as Record<string, unknown>;
    if (Object.keys(check).some(key => !['name', 'exists', 'type', 'required'].includes(key))
      || typeof check.name !== 'string' || !check.name.trim() || names.has(check.name)
      || typeof check.exists !== 'boolean' || (check.type !== undefined && (typeof check.type !== 'string' || !check.type.trim()))
      || (check.required !== undefined && typeof check.required !== 'boolean')
      || (!check.exists && (check.type !== undefined || check.required !== undefined))) return fail();
    names.add(check.name);
    return { name: check.name, exists: check.exists, ...(check.type !== undefined ? { type: check.type as string } : {}),
      ...(check.required !== undefined ? { required: check.required as boolean } : {}) };
  });
  return { props };
}

/** Absence is decidable here only for a closed, local defineProps declaration in script setup. */
function closedLocalPropNames(content: string, file: string): string[] | null {
  if (!file.endsWith('.vue') || inspectVueTreeInput(content, file)) return null;
  const setup = parseSfc(content, file).scriptSetup;
  if (!setup) return null;
  const source = ts.createSourceFile(file + '.ts', setup.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if ((source as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length) return null;
  const declarations: ts.CallExpression[] = [];
  let shadowed = false;
  const visit = (node: ts.Node) => {
    if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isParameter(node) || ts.isImportSpecifier(node))
      && node.name && ts.isIdentifier(node.name) && node.name.text === 'defineProps') shadowed = true;
    if (ts.isImportClause(node) && node.name?.text === 'defineProps') shadowed = true;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'defineProps') declarations.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (declarations.length !== 1 || shadowed) return null;
  const call = declarations[0]!;
  for (let parent = call.parent; parent && !ts.isSourceFile(parent); parent = parent.parent) {
    if (ts.isFunctionLike(parent) || ts.isBlock(parent) || ts.isConditionalExpression(parent)) return null;
    if (ts.isCallExpression(parent) && (!ts.isIdentifier(parent.expression) || parent.expression.text !== 'withDefaults')) return null;
  }
  const type = call.typeArguments?.[0];
  if (type && ts.isTypeLiteralNode(type)) return type.members.every(member => ts.isPropertySignature(member)
    && member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)))
    ? type.members.map(member => (member.name as ts.Identifier | ts.StringLiteral).text) : null;
  const argument = call.arguments[0];
  if (argument && ts.isArrayLiteralExpression(argument)) return argument.elements.every(ts.isStringLiteralLike)
    ? argument.elements.map(element => (element as ts.StringLiteralLike).text) : null;
  if (argument && ts.isObjectLiteralExpression(argument)) return argument.properties.every(member => ts.isPropertyAssignment(member)
    && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)))
    ? argument.properties.map(member => (member.name as ts.Identifier | ts.StringLiteral).text) : null;
  return null;
}

export function verifyContractExpectation(options: {
  contract: ComponentContract; content: string; expectation: ContractExpectation; sourceCurrent: boolean;
}) {
  const { contract, expectation } = options;
  const names = closedLocalPropNames(options.content, contract.filePath);
  const supported = options.sourceCurrent && names !== null && !contract.unresolvedTypes?.length
    && names.length === contract.props.length && names.every(name => contract.props.some(prop => prop.name === name));
  const checks = expectation.props.map(expected => {
    const actual = contract.props.find(prop => prop.name === expected.name);
    const matches = Boolean(actual) === expected.exists
      && (expected.type === undefined || actual?.type === expected.type)
      && (expected.required === undefined || actual?.required === expected.required);
    return { expected, actual: actual ? { name: actual.name, type: actual.type, required: actual.required } : null,
      status: supported ? matches ? 'PASS' : 'FAIL' : 'UNKNOWN',
      reason: supported ? 'Compared against a source-checked, local static defineProps contract.' : 'Source freshness or closed local prop declaration could not be established; no absence or success is certified.' };
  });
  return { scope: 'local-vue-prop-contract', status: checks.some(check => check.status === 'FAIL') ? 'FAIL'
    : checks.every(check => check.status === 'PASS') ? 'PASS' : 'UNKNOWN', checks,
    limitations: ['Checks only caller-supplied prop expectations on the current source. It does not certify business intent, consumer compatibility, application tests or unrelated file changes.'] };
}
