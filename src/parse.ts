import { traverse } from '@babel/core';
import type { Node } from '@babel/types';
import { type Comment } from '@babel/types';
import { Preprocessor } from 'content-tag';
import type { Parser } from 'prettier';
import { parsers as babelParsers } from 'prettier/plugins/babel.js';

import { PRINTER_NAME } from './config';
import type { Options } from './options.js';
import type { GlimmerTemplate, RawGlimmerTemplate } from './types/glimmer';
import { assert } from './utils';

const typescript = babelParsers['babel-ts'] as Parser<Node | undefined>;
const p = new Preprocessor();

interface PreparedResult {
  output: string;
  templateNodes: RawGlimmerTemplate[];
}

interface PreprocessedResult {
  /** Range of the template including <template></template> tags */
  templateRange: readonly [start: number, end: number];
  /** Range of the template content, excluding <template></template> tags */
  range: readonly [start: number, end: number];
  ast: GlimmerTemplate;
}

/** Traverses the AST and replaces the transformed template parts with other AST */
function convertAst(
  result: { ast: Node; code: string },
  preprocessedResult: PreprocessedResult[],
): void {
  let counter = 0;

  traverse(result.ast, {
    enter(path) {
      const node = path.node;
      if (
        node.type === 'ObjectExpression' ||
        node.type === 'BlockStatement' ||
        node.type === 'StaticBlock'
      ) {
        const range = node.range as [number, number];

        const template = preprocessedResult.find(
          (t) =>
            (t.templateRange[0] === range[0] &&
              t.templateRange[1] === range[1]) ||
            (t.templateRange[0] === range[0] - 1 &&
              t.templateRange[1] === range[1] + 1) ||
            (t.templateRange[0] === range[0] &&
              t.templateRange[1] === range[1] + 1),
        );

        if (!template) {
          return null;
        }
        counter++;
        assert('expected ast on template', template.ast);
        const { ast } = template;
        ast.extra.isAlreadyExportDefault =
          path.parent.type === 'ExportDefaultDeclaration' ||
          path.parentPath?.parent.type === 'ExportDefaultDeclaration';
        ast.extra.isDefaultTemplate =
          path.parent.type === 'ExportDefaultDeclaration' ||
          path.parent.type === 'Program' ||
          (path.parent.type === 'ExpressionStatement' &&
            path.parentPath?.parent.type === 'Program') ||
          (path.parent.type === 'TSAsExpression' &&
            path.parentPath?.parentPath?.parent.type === 'Program') ||
          path.parentPath?.parent.type === 'ExportDefaultDeclaration';

        ast.extra.isAssignment =
          !ast.extra.isDefaultTemplate && node.type !== 'StaticBlock';

        ast.leadingComments = node.leadingComments as Comment[];
        Object.assign(node, ast);
      }
      return null;
    },
  });

  if (counter !== preprocessedResult.length) {
    throw new Error('failed to process all templates');
  }
}

/**
 * Pre-processes the template info, parsing the template content to Glimmer AST,
 * fixing the offsets and locations of all nodes also calculates the block
 * params locations & ranges and adding it to the info
 */
function preprocess(
  prepared: PreparedResult,
  code: string,
): PreprocessedResult[] {
  return prepared.templateNodes.map((tpl) => {
    const range = [tpl.contentRange.start, tpl.contentRange.end] as const;
    const templateRange = [tpl.range.start, tpl.range.end] as const;
    const template = code.slice(...range);
    return {
      templateRange,
      range,
      ast: {
        type: 'FunctionDeclaration',
        leadingComments: [],
        range: [templateRange[0], templateRange[1]],
        start: templateRange[0],
        end: templateRange[1],
        extra: {
          isGlimmerTemplate: true,
          isDefaultTemplate: false,
          isAssignment: false,
          isAlreadyExportDefault: false,
          template,
        },
      },
    };
  });
}

function replaceRange(
  s: string,
  start: number,
  end: number,
  substitute: string,
): string {
  return s.slice(0, start) + substitute + s.slice(end);
}

const STATIC_OPEN = 'static{`';
const STATIC_CLOSE = '`}';
const NEWLINE = '\n';

/** FIXME: What is the purpose of this? */
function prepare(code: string): PreparedResult {
  const templateNodes = p.parse(code) as RawGlimmerTemplate[];
  let output = code;
  for (const templateNode of templateNodes.reverse()) {
    let prefix: string;
    let suffix: string;
    if (templateNode.type === 'class-member') {
      prefix = STATIC_OPEN;
      suffix = STATIC_CLOSE;
    } else {
      const nextWord = code.slice(templateNode.range.end).match(/\S+/);
      prefix = '{';
      suffix = '}';
      if (nextWord && nextWord[0] === 'as') {
        prefix = '(' + prefix;
        suffix = suffix + ')';
      } else if (!nextWord || ![',', ')'].includes(nextWord[0][0] || '')) {
        suffix += ';';
      }
    }

    const lineBreakCount = [...templateNode.contents].reduce(
      (sum, currentContents) => sum + (currentContents === NEWLINE ? 1 : 0),
      0,
    );
    const totalLength = templateNode.range.end - templateNode.range.start;
    const spaces = totalLength - prefix.length - suffix.length - lineBreakCount;
    const content = ' '.repeat(spaces) + NEWLINE.repeat(lineBreakCount);

    output = replaceRange(
      output,
      templateNode.range.start,
      templateNode.range.end,
      `${prefix}${content}${suffix}`,
    );
  }

  return {
    templateNodes,
    output,
  };
}

export const parser: Parser<Node | undefined> = {
  ...typescript,
  astFormat: PRINTER_NAME,

  async parse(code: string, options: Options): Promise<Node> {
    const prepared = prepare(code);
    const preprocessedResult = preprocess(prepared, code);
    const ast = await typescript.parse(prepared.output, options);
    assert('expected ast', ast);
    convertAst({ ast, code }, preprocessedResult);
    return ast;
  },
};
