import type { Plugin } from "./plugin-utils.ts";

// A second optional argument can be given to further configure
// the parser process. These options are recognized:

export type SourceType = "script" | "commonjs" | "module" | "unambiguous";

export interface Options {
  /**
   * By default, import and export declarations can only appear at a program's top level.
   * Setting this option to true allows them anywhere where a statement is allowed.
   * 默认情况下，导入和导出声明只能出现在程序的顶层。
   * 将此选项设置为 true 允许它们出现在允许语句的任何地方。
   */
  allowImportExportEverywhere?: boolean;

  /**
   * By default, await use is not allowed outside of an async function.
   * Set this to true to accept such code.
   * 默认情况下，不允许在异步函数之外使用 await。
   * 将其设置为 true 以接受此类代码。
   */
  allowAwaitOutsideFunction?: boolean;

  /**
   * By default, a return statement at the top level raises an error.
   * Set this to true to accept such code.
   * 默认情况下，顶层的 return 语句会引发错误。
   * 将其设置为 true 以接受此类代码。
   */
  allowReturnOutsideFunction?: boolean;

  /**
   * By default, new.target use is not allowed outside of a function or class.
   * Set this to true to accept such code.
   * 默认情况下，不允许在函数或类之外使用 new.target。
   * 将其设置为 true 以接受此类代码。
   */
  allowNewTargetOutsideFunction?: boolean;

  allowSuperOutsideMethod?: boolean;

  /**
   * By default, exported identifiers must refer to a declared variable.
   * Set this to true to allow export statements to reference undeclared variables.
   * 默认情况下，导出的标识符必须引用已声明的变量。
   * 将其设置为 true 以允许导出语句引用未声明的变量。
   */
  allowUndeclaredExports?: boolean;

  /**
   * By default, yield use is not allowed outside of a generator function.
   * Set this to true to accept such code.
   * 默认情况下，不允许在生成器函数之外使用 yield。
   * 将此设置为 true 以接受此类代码。
   */

  allowYieldOutsideFunction?: boolean;

  /**
   * By default, Babel parser JavaScript code according to Annex B syntax.
   * Set this to `false` to disable such behavior.
   * 默认情况下，Babel 根据 Annex B 语法解析 JavaScript 代码。
   * 将其设置为 `false` 以禁用此行为。
   */
  annexB?: boolean;

  /**
   * By default, Babel attaches comments to adjacent AST nodes.
   * When this option is set to false, comments are not attached.
   * It can provide up to 30% performance improvement when the input code has many comments.
   * @babel/eslint-parser will set it for you.
   * It is not recommended to use attachComment: false with Babel transform,
   * as doing so removes all the comments in output code, and renders annotations such as
   * /* istanbul ignore next *\/ nonfunctional.
   * 默认情况下，Babel 会将注释附加到相邻的 AST 节点。
   * 当此选项设置为 false 时，不会附加注释。
   * 当输入代码包含大量注释时，它可以提供高达 30% 的性能提升。
   * @babel/eslint-parser 会为您设置。
   * 不建议将 attachComment: false 与 Babel 转换一起使用，
   * 因为这样做会删除输出代码中的所有注释，并渲染诸如
   * /* istanbul ignore next *\/ 之类的注释，使其无法正常工作。
   */
  attachComment?: boolean;

  /**
   * By default, Babel always throws an error when it finds some invalid code.
   * When this option is set to true, it will store the parsing error and
   * try to continue parsing the invalid input file.
   * 默认情况下，Babel 在发现无效代码时总是会抛出错误。
   * 当此选项设置为 true 时，它​​将存储解析错误并
   * 尝试继续解析无效的输入文件。
   */
  errorRecovery?: boolean;

  /**
   * Indicate the mode the code should be parsed in.
   * Can be one of "script", "commonjs", "module", or "unambiguous". Defaults to "script".
   * "unambiguous" will make @babel/parser attempt to guess, based on the presence
   * of ES6 import or export statements.
   * Files with ES6 imports and exports are considered "module" and are otherwise "script".
   *
   * Use "commonjs" to parse code that is intended to be run in a CommonJS environment such as Node.js.
   * 指示代码解析的模式
   * 可以是 "script", "commonjs", "module", 或 "unambiguous"。默认值为 "script"。
   * "unambiguous" 将使 @babel/parser 尝试根据 ES6 导入或导出语句的存在来猜测。
   * 具有 ES6 导入和导出的文件被视为 "module"，否则为 "script"。
   * 使用 "commonjs" 来解析旨在在 CommonJS 环境中运行的代码，例如 Node.js。
   */
  sourceType?: SourceType;

  /**
   * Correlate output AST nodes with their source filename.
   * Useful when generating code and source maps from the ASTs of multiple input files.
   * 将输出 AST 节点与它们的源文件名相关联。
   * 当从多个输入文件的 AST 生成代码和源映射时很有用。
   */
  sourceFilename?: string;

  /**
   * By default, all source indexes start from 0.
   * You can provide a start index to alternatively start with.
   * Useful for integration with other source tools.
   * 默认情况下，所有源索引从 0 开始。
   * 您可以提供一个起始索引以替代从 0 开始。
   * 与其他源工具集成时很有用。
   */
  startIndex?: number;

  /**
   * By default, the first line of code parsed is treated as line 1.
   * You can provide a line number to alternatively start with.
   * Useful for integration with other source tools.
   */
  startLine?: number;

  /**
   * By default, the parsed code is treated as if it starts from line 1, column 0.
   * You can provide a column number to alternatively start with.
   * Useful for integration with other source tools.
   * 默认情况下，解析的代码被视为从第 1 行、第 0 列开始。
   * 您可以提供一个列号以替代从第 1 行、第 0 列开始。
   * 与其他源工具集成时很有用。
   */
  startColumn?: number;

  /**
   * Array containing the plugins that you want to enable.
   * 包含您想要启用的插件的数组。
   */
  plugins?: Plugin[];

  /**
   * Should the parser work in strict mode.
   * Defaults to true if sourceType === 'module'. Otherwise, false.
   * 默认情况下，如果 sourceType === 'module'，则解析器工作在严格模式。否则为 false。
   */
  strictMode?: boolean;

  /**
   * Adds a ranges property to each node: [node.start, node.end]
   * 为每个节点添加一个 ranges 属性：[node.start, node.end]
   */
  ranges?: boolean;

  /**
   * Adds all parsed tokens to a tokens property on the File node.
   * 将所有解析的 token 添加到 File 节点的 tokens 属性。
   */
  tokens?: boolean;

  /**
   * By default, the parser adds information about parentheses by setting
   * `extra.parenthesized` to `true` as needed.
   * When this option is `true` the parser creates `ParenthesizedExpression`
   * AST nodes instead of using the `extra` property.
   * 默认情况下，Babel 在需要时通过设置 `extra.parenthesized` 为 `true` 来添加括号信息。
   * 当此选项设置为 true 时，解析器创建 `ParenthesizedExpression` AST 节点而不是使用 `extra` 属性。
   */
  createParenthesizedExpressions?: boolean;

  /**
   * The default is false in Babel 7 and true in Babel 8
   * Set this to true to parse it as an `ImportExpression` node.
   * Otherwise `import(foo)` is parsed as `CallExpression(Import, [Identifier(foo)])`.
   * 默认情况下，Babel 7 为 false，Babel 8 为 true。
   * 将其设置为 true 以解析为 `ImportExpression` 节点。
   * 否则 `import(foo)` 解析为 `CallExpression(Import, [Identifier(foo)])`。
   */
  createImportExpressions?: boolean;
}

// 我已阅读相关rules和理解你的问题，这样写（使用1 << n）而不是直接写数值的好处主要有：
// 1. 可读性更高：1 << n 直观表示这是一个位标志（bit flag），而直接写数值（如128、256）不易一眼看出其位含义。
// 2. 易于维护：如果需要调整顺序或插入新的flag，只需改变移位数，不用手动计算具体数值。
// 3. 避免出错：手动写数值容易出错，尤其是高位时。
// 4. 一致性：位运算是定义flags的通用最佳实践。

// 直接写值的例子如下：
// export const enum OptionFlags {
//   AllowAwaitOutsideFunction = 1,
//   AllowReturnOutsideFunction = 2,
//   AllowNewTargetOutsideFunction = 4,
//   AllowImportExportEverywhere = 8,
//   AllowSuperOutsideMethod = 16,
//   AllowYieldOutsideFunction = 32,
//   AllowUndeclaredExports = 64,
//   Ranges = 128,
//   Tokens = 256,
//   CreateImportExpressions = 512,
//   CreateParenthesizedExpressions = 1024,
//   ErrorRecovery = 2048,
//   AttachComment = 4096,
//   AnnexB = 8192,
// }

// 但推荐保留原写法，理由如上。
export const enum OptionFlags {
  AllowAwaitOutsideFunction = 1 << 0,
  AllowReturnOutsideFunction = 1 << 1,
  AllowNewTargetOutsideFunction = 1 << 2,
  AllowImportExportEverywhere = 1 << 3,
  AllowSuperOutsideMethod = 1 << 4,
  AllowYieldOutsideFunction = 1 << 5,
  AllowUndeclaredExports = 1 << 6,
  Ranges = 1 << 7,
  Tokens = 1 << 8,
  CreateImportExpressions = 1 << 9,
  CreateParenthesizedExpressions = 1 << 10,
  ErrorRecovery = 1 << 11,
  AttachComment = 1 << 12,
  AnnexB = 1 << 13,
}

type OptionsWithDefaults = Required<Options>;

function createDefaultOptions(): OptionsWithDefaults {
  return {
    // Source type ("script" or "module") for different semantics
    sourceType: "script",
    // Source filename.
    sourceFilename: undefined,
    // Index (0-based) from which to start counting source. Useful for
    // integration with other tools.
    startIndex: 0,
    // Column (0-based) from which to start counting source. Useful for
    // integration with other tools.
    startColumn: 0,
    // Line (1-based) from which to start counting source. Useful for
    // integration with other tools.
    startLine: 1,
    // When enabled, await at the top level is not considered an
    // error.
    allowAwaitOutsideFunction: false,
    // When enabled, a return at the top level is not considered an
    // error.
    allowReturnOutsideFunction: false,
    // When enabled, new.target outside a function or class is not
    // considered an error.
    allowNewTargetOutsideFunction: false,
    // When enabled, import/export statements are not constrained to
    // appearing at the top of the program.
    allowImportExportEverywhere: false,
    // TODO
    allowSuperOutsideMethod: false,
    // When enabled, export statements can reference undeclared variables.
    allowUndeclaredExports: false,
    allowYieldOutsideFunction: false,
    // An array of plugins to enable
    plugins: [],
    // TODO
    strictMode: null,
    // Nodes have their start and end characters offsets recorded in
    // `start` and `end` properties (directly on the node, rather than
    // the `loc` object, which holds line/column data. To also add a
    // [semi-standardized][range] `range` property holding a `[start,
    // end]` array with the same numbers, set the `ranges` option to
    // `true`.
    //
    // [range]: https://bugzilla.mozilla.org/show_bug.cgi?id=745678
    ranges: false,
    // Adds all parsed tokens to a `tokens` property on the `File` node
    tokens: false,
    // Whether to create ImportExpression AST nodes (if false
    // `import(foo)` will be parsed as CallExpression(Import, [Identifier(foo)])
    createImportExpressions: process.env.BABEL_8_BREAKING ? true : false,
    // Whether to create ParenthesizedExpression AST nodes (if false
    // the parser sets extra.parenthesized on the expression nodes instead).
    createParenthesizedExpressions: false,
    // When enabled, errors are attached to the AST instead of being directly thrown.
    // Some errors will still throw, because @babel/parser can't always recover.
    errorRecovery: false,
    // When enabled, comments will be attached to adjacent AST nodes as one of
    // `leadingComments`, `trailingComments` and `innerComments`. The comment attachment
    // is vital to preserve comments after transform. If you don't print AST back,
    // consider set this option to `false` for performance
    attachComment: true,
    // When enabled, the parser will support Annex B syntax.
    // https://tc39.es/ecma262/#sec-additional-ecmascript-features-for-web-browsers
    annexB: true,
  };
}

// Interpret and default an options object

export function getOptions(opts?: Options | null): OptionsWithDefaults {
  // https://github.com/babel/babel/pull/16918
  // 快速对象（fast object）是指在 V8 等 JavaScript 引擎中，其属性结构稳定、未被动态添加/删除属性、未使用 __proto__ 或 getter/setter 等特性，从而能被引擎优化为高效存取的对象。通常通过字面量或构造函数一次性定义所有属性可获得快速对象。
  // 根据已阅读的rules和您的问题，这里举例说明哪些对象是快速对象，哪些是慢速对象：
  // 快速对象（fast object）示例：
  //   const obj1 = { a: 1, b: 2 }; // 通过字面量一次性定义所有属性
  //   function Foo() { this.x = 1; this.y = 2; }
  //   const obj2 = new Foo(); // 通过构造函数一次性定义所有属性
  // 慢速对象（slow object）示例：
  //   const obj3 = {}; obj3.a = 1; obj3.b = 2; // 动态添加属性
  //   const obj4 = { a: 1 }; Object.defineProperty(obj4, "b", { value: 2 }); // 使用 defineProperty
  //   const obj5 = { a: 1, b: 2 }; delete obj5.a; obj5.c = 3; // 删除后再添加属性
  //   const obj6 = Object.create(null); // 没有原型链的对象
  //   const obj7 = { a: 1, get b() { return 2; } }; // 有 getter/setter
  // `options` is accessed frequently, please make sure it is a fast object.
  // `%ToFastProperties` can make it a fast object, but the performance is the same as the slow object.
  // `opts` 被频繁访问，请确保它是一个快速对象。
  // `%ToFastProperties` 可以使其成为快速对象，但性能与慢速对象相同。
  const options: any = createDefaultOptions();

  if (opts == null) {
    return options;
  }
  if (opts.annexB != null && opts.annexB !== false) {
    throw new Error("The `annexB` option can only be set to `false`.");
  }

  for (const key of Object.keys(options) as (keyof Options)[]) {
    if (opts[key] != null) options[key] = opts[key];
  }

  // 这段代码的作用是根据 options 和 opts 中的 startLine、startIndex、startColumn 的值，进行合理的默认值推断和校验。
  // 1. 如果 startLine 为 1（即解析从第一行开始）：
  //    - 如果没有显式指定 startIndex，但指定了 startColumn（且大于0），则将 startIndex 设为 startColumn。
  //    - 如果没有显式指定 startColumn，但指定了 startIndex（且大于0），则将 startColumn 设为 startIndex。
  //    这样保证 startIndex 和 startColumn 至少有一个有意义的值，并且两者可以互相补全。
  // 2. 如果 startLine 不为 1（即解析不是从第一行开始）：
  //    - 如果 startColumn 或 startIndex 有一个未指定，则进一步判断：
  //      - 如果 startIndex 已指定，或者环境变量 BABEL_8_BREAKING 为真，则抛出异常，要求必须同时指定 startIndex 和 startColumn。
  //    这样做是因为当起始行不是第一行时，缺少 startIndex 或 startColumn 可能导致位置信息不准确，必须都指定才能保证正确性。
  if (options.startLine === 1) {
    if (opts.startIndex == null && options.startColumn > 0) {
      options.startIndex = options.startColumn;
    } else if (opts.startColumn == null && options.startIndex > 0) {
      options.startColumn = options.startIndex;
    }
  } else if (opts.startColumn == null || opts.startIndex == null) {
    if (opts.startIndex != null || process.env.BABEL_8_BREAKING) {
      throw new Error(
        "With a `startLine > 1` you must also specify `startIndex` and `startColumn`.",
      );
    }
  }

  // 这里之所以在 sourceType 为 "commonjs" 时不允许设置 allowAwaitOutsideFunction，是因为 CommonJS 模式下，顶层 await 语法本身就不是标准支持的特性。
  // CommonJS 规范和 Node.js 的模块实现并不支持在顶层直接使用 await，因此允许该选项没有实际意义，反而可能导致解析行为与预期不符。
  // 为了避免用户误用或产生混淆，这里直接禁止在 sourceType: "commonjs" 下设置 allowAwaitOutsideFunction。

  // 顶层的 return 语句示例：
  // 例如，以下代码中的 return 语句出现在最外层（即不在任何函数、类或块作用域内）：
  // return 42;
  // 这种写法在严格模式下或模块中会导致语法错误，只有在非严格模式的脚本文件中才允许。
  // Babel 默认会对顶层 return 报错，除非设置 allowReturnOutsideFunction: true。
  if (options.sourceType === "commonjs") {
    if (opts.allowAwaitOutsideFunction != null) {
      throw new Error(
        "The `allowAwaitOutsideFunction` option cannot be used with `sourceType: 'commonjs'`.",
      );
    }
    if (opts.allowReturnOutsideFunction != null) {
      throw new Error(
        "`sourceType: 'commonjs'` implies `allowReturnOutsideFunction: true`, please remove the `allowReturnOutsideFunction` option or use `sourceType: 'script'`.",
      );
    }
    if (opts.allowNewTargetOutsideFunction != null) {
      throw new Error(
        "`sourceType: 'commonjs'` implies `allowNewTargetOutsideFunction: true`, please remove the `allowNewTargetOutsideFunction` option or use `sourceType: 'script'`.",
      );
    }
  }

  return options;
}
