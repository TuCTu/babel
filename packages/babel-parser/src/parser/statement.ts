/**
 * Statement Parser - Babel 解析器中的语句解析器核心
 *
 * 这个文件定义了 StatementParser 抽象类，是 Babel 解析器中专门负责语句解析的核心组件。
 * 它继承自 ExpressionParser，负责将 JavaScript/TypeScript 中的各种语句转换为 AST 节点。
 *
 * 🎯 主要功能：
 * 1. 顶层程序解析 - 处理整个文件的解析入口
 * 2. 语句类型识别与分发 - 根据 token 类型分发到具体解析方法
 * 3. 控制流语句解析 - if, switch, for, while, do-while 等
 * 4. 跳转语句解析 - break, continue, return, throw 等
 * 5. 异常处理解析 - try-catch-finally 语句
 * 6. 声明语句解析 - var, let, const, function, class 等
 * 7. 模块语句解析 - import, export 语句
 * 8. 现代 JS 特性 - 装饰器、using 声明、私有字段等
 *
 * 🏗️ 架构特点：
 * - 继承层次：Tokenizer -> UtilParser -> NodeUtils -> LValParser -> ExpressionParser -> StatementParser
 * - 递归下降解析：每个语句类型都有对应的解析方法
 * - 状态管理：作用域、标签、严格模式等状态的管理
 * - 错误处理：提供详细的错误位置和恢复机制
 *
 * 📊 支持的语句类型：
 * - 控制流：if, switch, for, while, do-while
 * - 跳转：break, continue, return, throw
 * - 异常：try-catch-finally
 * - 声明：var, let, const, function, class
 * - 模块：import, export
 * - 其他：with, debugger, 块语句，表达式语句
 */

import type * as N from "../types.ts";
import {
  tokenIsIdentifier,
  tokenIsKeywordOrIdentifier,
  tokenIsLoop,
  tokenIsTemplate,
  tt,
  type TokenType,
  getExportedToken,
} from "../tokenizer/types.ts";
import ExpressionParser from "./expression.ts";
import { Errors } from "../parse-error.ts";
import { isIdentifierChar, isIdentifierStart } from "../util/identifier.ts";
import * as charCodes from "charcodes";
import {
  ScopeFlag,
  ClassElementType,
  BindingFlag,
} from "../util/scopeflags.ts";
import { ExpressionErrors } from "./util.ts";
import { ParamKind, functionFlags } from "../util/production-parameter.ts";
import {
  newExpressionScope,
  newParameterDeclarationScope,
} from "../util/expression-scope.ts";
import { OptionFlags, type SourceType } from "../options.ts";
import { Token } from "../tokenizer/index.ts";
import type { Position } from "../util/location.ts";
import { createPositionWithColumnOffset } from "../util/location.ts";
import type { Undone } from "./node.ts";
import type Parser from "./index.ts";
import { ParseBindingListFlags } from "./lval.ts";
import { LoopLabelKind } from "../tokenizer/state.ts";

// 标签类型常量 - 用于标识循环和 switch 语句的标签
// Label type constants - used to identify labels for loops and switch statements
const loopLabel = { kind: LoopLabelKind.Loop } as const,
  switchLabel = { kind: LoopLabelKind.Switch } as const;

/**
 * 函数解析标志枚举
 * Function parsing flags enumeration
 *
 * 用于控制函数解析的不同模式和选项
 * Used to control different modes and options for function parsing
 */
export const enum ParseFunctionFlag {
  Expression = 0b0000, // 函数表达式 - Function expression
  Declaration = 0b0001, // 函数声明 - Function declaration
  HangingDeclaration = 0b0010, // 悬挂声明 - Hanging declaration (single statement context)
  NullableId = 0b0100, // 可空标识符 - Nullable identifier (anonymous functions allowed)
  Async = 0b1000, // 异步函数 - Async function
}

/**
 * 语句解析标志枚举
 * Statement parsing flags enumeration
 *
 * 用于控制在不同上下文中允许解析哪些类型的语句
 * Used to control which types of statements are allowed in different contexts
 */
export const enum ParseStatementFlag {
  StatementOnly = 0b0000, // 仅普通语句 - Only regular statements
  AllowImportExport = 0b0001, // 允许 import/export - Allow import/export statements
  AllowDeclaration = 0b0010, // 允许声明语句 - Allow declaration statements
  AllowFunctionDeclaration = 0b0100, // 允许函数声明 - Allow function declarations
  AllowLabeledFunction = 0b1000, // 允许标签函数 - Allow labeled functions (Annex B)
}

// 孤立代理项正则表达式 - 用于检测 Unicode 代理对中的孤立代理项
// Lone surrogate regex - used to detect lone surrogates in Unicode surrogate pairs
const loneSurrogate = /[\uD800-\uDFFF]/u;

// 关键字关系操作符正则表达式 - 用于匹配 'in' 或 'instanceof' 关键字
// Keyword relational operator regex - used to match 'in' or 'instanceof' keywords
const keywordRelationalOperator = /in(?:stanceof)?/y;

/**
 * Convert tokens for backward Babel 7 compat.
 * tt.privateName => tt.hash + tt.name
 * tt.templateTail => tt.backquote/tt.braceR + tt.template + tt.backquote
 * tt.templateNonTail => tt.backquote/tt.braceR + tt.template + tt.dollarBraceL
 * For performance reasons this routine mutates `tokens`, it is okay
 * here since we execute `parseTopLevel` once for every file.
 *
 * Babel 7 兼容性 Token 转换器
 * Babel 7 Compatibility Token Converter
 *
 * 🎯 主要作用：
 * 这个函数是为了向后兼容 Babel 7 而设计的 token 转换器。它将 Babel 8 的内部
 * token 格式转换为 Babel 7 兼容的格式，确保现有的工具和插件能够正常工作。
 *
 * 🔍 核心转换逻辑：
 *
 * 1. **私有字段名称转换**：
 *    - Babel 8 内部：#privateField → 一个 privateName token
 *    - Babel 7 兼容：#privateField → # (hash token) + privateField (name token)
 *    - 转换规则：tt.privateName => tt.hash + tt.name
 *
 * 2. **模板字符串转换**：
 *    - 模板尾部：`end` → ` + end + `
 *    - 模板中间：`start${` → ` + start + ${
 *    - 模板延续：}middle${ → } + middle + ${
 *    - 转换规则：
 *      • tt.templateTail => tt.backQuote + tt.template + tt.backQuote
 *      • tt.templateNonTail => tt.backQuote/tt.braceR + tt.template + tt.dollarBraceL
 *
 * 💡 设计原理：
 *
 * • **性能优化**：直接修改原数组而不是创建新数组，减少内存分配
 * • **版本兼容**：通过环境变量 BABEL_8_BREAKING 控制是否启用兼容模式
 * • **单次执行**：每个文件只执行一次，性能影响可控
 * • **生态支持**：让 Babel 7 时代的工具（ESLint、Prettier等）继续工作
 *
 * 🔧 转换过程：
 *
 * 私有字段转换流程：
 * 1. 检测 tt.privateName token（如 #field）
 * 2. 计算位置：hash 符号结束位置 = start + 1
 * 3. 创建两个新 token：hash token (#) + name token (field)
 * 4. 替换原 token 并调整索引
 *
 * 模板字符串转换流程：
 * 1. 判断模板类型：templateTail 还是 templateNonTail
 * 2. 确定边界字符：开始(` 或 })，结束(` 或 ${)
 * 3. 创建三个 token：开始边界 + 模板内容 + 结束边界
 * 4. 替换并调整索引：i += 2 跳过新插入的 token
 *
 * 🎯 使用场景：
 * - 工具兼容性：ESLint 插件、Prettier、IDE 语法高亮
 * - 插件生态：Babel 7 插件继续工作
 * - 平滑迁移：为生态系统提供升级缓冲
 *
 * ⚡ 性能特点：
 * - 优点：就地修改节省内存，单次执行，条件执行
 * - 注意：有副作用（修改输入数组），顺序敏感，需要正确的索引管理
 *
 * @param tokens - token 数组（包含 Token 和 Comment），会被直接修改
 * @param input - 输入的源代码字符串，用于确定字符类型
 * @param startIndex - 开始索引位置，用于计算相对位置
 * @returns 转换后的 token 数组（与输入是同一个数组）
 */
function babel7CompatTokens(
  tokens: (Token | N.Comment)[],
  input: string,
  startIndex: number,
) {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const { type } = token;
    if (typeof type === "number") {
      if (!process.env.BABEL_8_BREAKING) {
        if (type === tt.privateName) {
          const { loc, start, value, end } = token;
          const hashEndPos = start + 1;
          const hashEndLoc = createPositionWithColumnOffset(loc.start, 1);
          tokens.splice(
            i,
            1,
            new Token({
              // @ts-expect-error: hacky way to create token
              type: getExportedToken(tt.hash),
              value: "#",
              start: start,
              end: hashEndPos,
              startLoc: loc.start,
              endLoc: hashEndLoc,
            }),
            new Token({
              // @ts-expect-error: hacky way to create token
              type: getExportedToken(tt.name),
              value: value,
              start: hashEndPos,
              end: end,
              startLoc: hashEndLoc,
              endLoc: loc.end,
            }),
          );
          i++;
          continue;
        }

        if (tokenIsTemplate(type)) {
          const { loc, start, value, end } = token;
          const backquoteEnd = start + 1;
          const backquoteEndLoc = createPositionWithColumnOffset(loc.start, 1);
          let startToken;
          if (input.charCodeAt(start - startIndex) === charCodes.graveAccent) {
            startToken = new Token({
              // @ts-expect-error: hacky way to create token
              type: getExportedToken(tt.backQuote),
              value: "`",
              start: start,
              end: backquoteEnd,
              startLoc: loc.start,
              endLoc: backquoteEndLoc,
            });
          } else {
            startToken = new Token({
              // @ts-expect-error: hacky way to create token
              type: getExportedToken(tt.braceR),
              value: "}",
              start: start,
              end: backquoteEnd,
              startLoc: loc.start,
              endLoc: backquoteEndLoc,
            });
          }
          let templateValue,
            templateElementEnd,
            templateElementEndLoc,
            endToken;
          if (type === tt.templateTail) {
            // ends with '`'
            templateElementEnd = end - 1;
            templateElementEndLoc = createPositionWithColumnOffset(loc.end, -1);
            templateValue = value === null ? null : value.slice(1, -1);
            endToken = new Token({
              // @ts-expect-error: hacky way to create token
              type: getExportedToken(tt.backQuote),
              value: "`",
              start: templateElementEnd,
              end: end,
              startLoc: templateElementEndLoc,
              endLoc: loc.end,
            });
          } else {
            // ends with `${`
            templateElementEnd = end - 2;
            templateElementEndLoc = createPositionWithColumnOffset(loc.end, -2);
            templateValue = value === null ? null : value.slice(1, -2);
            endToken = new Token({
              // @ts-expect-error: hacky way to create token
              type: getExportedToken(tt.dollarBraceL),
              value: "${",
              start: templateElementEnd,
              end: end,
              startLoc: templateElementEndLoc,
              endLoc: loc.end,
            });
          }
          tokens.splice(
            i,
            1,
            startToken,
            new Token({
              // @ts-expect-error: hacky way to create token
              type: getExportedToken(tt.template),
              value: templateValue,
              start: backquoteEnd,
              end: templateElementEnd,
              startLoc: backquoteEndLoc,
              endLoc: templateElementEndLoc,
            }),
            endToken,
          );
          i += 2;
          continue;
        }
      }
      // @ts-expect-error: we manipulate `token` for performance reasons
      token.type = getExportedToken(type);
    }
  }
  return tokens;
}
/**
 * StatementParser 抽象类 - 语句解析器核心
 * StatementParser abstract class - Core statement parser
 *
 * 这是 Babel 解析器中负责语句解析的核心类，继承自 ExpressionParser。
 * 它实现了 JavaScript/TypeScript 中所有类型语句的解析逻辑。
 *
 * 🎯 主要职责：
 * 1. 程序顶层解析 - parseTopLevel(), parseProgram()
 * 2. 语句分发解析 - parseStatementLike(), parseStatementContent()
 * 3. 控制流语句 - if, switch, for, while, do-while
 * 4. 跳转语句 - break, continue, return, throw
 * 5. 异常处理 - try-catch-finally
 * 6. 声明语句 - var, let, const, function, class
 * 7. 模块语句 - import, export
 * 8. 现代特性 - 装饰器, using 声明, 私有字段
 *
 * 🏗️ 解析策略：
 * - 递归下降解析：每个语句类型有专门的解析方法
 * - 状态管理：维护作用域、标签、严格模式等状态
 * - 错误恢复：提供详细的错误信息和恢复机制
 * - 向后兼容：支持 Babel 7 的 token 格式转换
 */
export default abstract class StatementParser extends ExpressionParser {
  // ### Statement parsing
  // ### 语句解析

  // Parse a program. Initializes the parser, reads any number of
  // statements, and wraps them in a Program node.  Optionally takes a
  // `program` argument.  If present, the statements will be appended
  // to its body instead of creating a new node.
  // 解析程序。初始化解析器，读取任意数量的语句，
  // 并将它们包装在 Program 节点中。可选地接受 `program` 参数。
  // 如果存在，语句将被追加到其主体中，而不是创建新节点。

  /**
   * 解析顶层文件结构 - 解析器入口点
   * Parse top-level file structure - parser entry point
   *
   * 这是解析器的主入口方法，负责解析整个文件的顶层结构。
   * 它会初始化程序节点，解析所有顶层语句，并处理 token 兼容性转换。
   *
   * @param file - 未完成的文件节点
   * @param program - 未完成的程序节点
   * @returns 完成的文件节点
   */
  parseTopLevel(
    this: Parser,
    file: Undone<N.File>,
    program: Undone<N.Program>,
  ): N.File {
    file.program = this.parseProgram(
      program,
      tt.eof,
      this.options.sourceType === "module" ? "module" : "script",
    );
    file.comments = this.comments;

    if (this.optionFlags & OptionFlags.Tokens) {
      file.tokens = babel7CompatTokens(
        this.tokens,
        this.input,
        this.startIndex,
      );
    }

    return this.finishNode(file, "File");
  }

  /**
   * 解析程序主体 - 解析程序节点的核心方法
   * Parse program body - core method for parsing program nodes
   *
   * 解析程序的主体部分，包括解释器指令、语句块和模块导出检查。
   * 处理严格模式、顶层 await 等特性。
   *
   * @param program - 未完成的程序节点
   * @param end - 结束标记类型
   * @param sourceType - 源码类型（module 或 script）
   * @returns 完成的程序节点
   */
  parseProgram(
    this: Parser,
    program: Undone<N.Program>,
    end: TokenType,
    sourceType: SourceType,
  ): N.Program {
    program.sourceType = sourceType;
    program.interpreter = this.parseInterpreterDirective();
    this.parseBlockBody(program, true, true, end);
    if (this.inModule) {
      if (
        !(this.optionFlags & OptionFlags.AllowUndeclaredExports) &&
        this.scope.undefinedExports.size > 0
      ) {
        for (const [localName, at] of Array.from(this.scope.undefinedExports)) {
          this.raise(Errors.ModuleExportUndefined, at, { localName });
        }
      }
      this.addExtra(program, "topLevelAwait", this.state.hasTopLevelAwait);
    }
    let finishedProgram: N.Program;
    if (end === tt.eof) {
      // finish at eof for top level program
      finishedProgram = this.finishNode(program, "Program");
    } else {
      // finish immediately before the end token
      finishedProgram = this.finishNodeAt(
        program,
        "Program",
        createPositionWithColumnOffset(this.state.startLoc, -1),
      );
    }
    return finishedProgram;
  }

  /**
   * cast a Statement to a Directive. This method mutates input statement.
   * 将语句转换为指令。此方法会改变输入语句。
   */
  stmtToDirective(stmt: N.ExpressionStatement): N.Directive {
    const directive = this.castNodeTo(stmt, "Directive");

    const directiveLiteral = this.castNodeTo(
      stmt.expression,
      "DirectiveLiteral",
    );
    const expressionValue = directiveLiteral.value;
    const raw = this.input.slice(
      this.offsetToSourcePos(directiveLiteral.start),
      this.offsetToSourcePos(directiveLiteral.end),
    );
    const val = (directiveLiteral.value = raw.slice(1, -1)); // remove quotes

    this.addExtra(directiveLiteral, "raw", raw);
    this.addExtra(directiveLiteral, "rawValue", val);
    this.addExtra(directiveLiteral, "expressionValue", expressionValue);

    directive.value = directiveLiteral;
    delete stmt.expression;

    return directive;
  }

  /**
   * 解析解释器指令 - 解析 shebang 行
   * Parse interpreter directive - parse shebang line
   *
   * 解析文件开头的解释器指令（如 #!/usr/bin/env node），
   * 如果不存在则返回 null。
   *
   * @returns 解释器指令节点或 null
   */
  parseInterpreterDirective(): N.InterpreterDirective | null {
    if (!this.match(tt.interpreterDirective)) {
      return null;
    }

    const node = this.startNode<N.InterpreterDirective>();
    node.value = this.state.value;
    this.next();
    return this.finishNode(node, "InterpreterDirective");
  }

  /**
   * 检查当前是否为 let 声明
   * Check if current is a let declaration
   *
   * 检查当前上下文关键字是否为 'let' 并且后面跟着绑定原子。
   * 用于区分 let 关键字和 let 标识符。
   *
   * @returns 如果是 let 声明则返回 true
   */
  isLet(): boolean {
    if (!this.isContextual(tt._let)) {
      return false;
    }
    return this.hasFollowingBindingAtom();
  }

  /**
   * 检查当前是否为 using 声明
   * Check if current is a using declaration
   *
   * 检查当前上下文关键字是否为 'using' 并且后面跟着绑定标识符。
   * using 声明是 ES2023 的资源管理提案特性。
   *
   * @returns 如果是 using 声明则返回 true
   */
  isUsing(): boolean {
    if (!this.isContextual(tt._using)) {
      return false;
    }
    const next = this.nextTokenInLineStart();
    const nextCh = this.codePointAtPos(next);
    return this.chStartsBindingIdentifier(nextCh, next);
  }

  /**
   * 检查是否为 for-using 循环声明
   * Check if current is a for-using loop declaration
   *
   * 检查当前是否在 for 循环中使用 using 声明。
   * 需要特殊处理 'for (using of' 的语法歧义。
   *
   * @returns 如果是 for-using 声明则返回 true
   */
  isForUsing(): boolean {
    if (!this.isContextual(tt._using)) {
      return false;
    }
    const next = this.nextTokenInLineStart();
    const nextCh = this.codePointAtPos(next);
    if (this.isUnparsedContextual(next, "of")) {
      const nextCharAfterOf = this.lookaheadCharCodeSince(next + 2);
      // `for( using of` must start either a for-lhs-of statement
      // or a for lexical declaration
      if (
        nextCharAfterOf !== charCodes.equalsTo &&
        nextCharAfterOf !== charCodes.colon &&
        // recover from `for(using of;...);`
        nextCharAfterOf !== charCodes.semicolon
      ) {
        return false;
      }
    }
    if (
      this.chStartsBindingIdentifier(nextCh, next) ||
      this.isUnparsedContextual(next, "void")
    ) {
      return true;
    }
    return false;
  }

  /**
   * 检查当前是否为 await using 声明
   * Check if current is an await using declaration
   *
   * 检查当前是否为异步资源管理的 await using 声明。
   * 这是 ES2023 异步资源管理提案的特性。
   *
   * @returns 如果是 await using 声明则返回 true
   */
  isAwaitUsing(): boolean {
    if (!this.isContextual(tt._await)) {
      return false;
    }
    let next = this.nextTokenInLineStart();
    if (this.isUnparsedContextual(next, "using")) {
      next = this.nextTokenInLineStartSince(next + 5);
      const nextCh = this.codePointAtPos(next);
      if (this.chStartsBindingIdentifier(nextCh, next)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 检查字符是否开始绑定标识符
   * Check if character starts a binding identifier
   *
   * 检查给定位置的字符是否可以开始一个绑定标识符，
   * 需要排除关系运算符关键字（in, instanceof）。
   *
   * @param ch - 字符码
   * @param pos - 字符位置
   * @returns 如果字符可以开始绑定标识符则返回 true
   */
  chStartsBindingIdentifier(ch: number, pos: number) {
    if (isIdentifierStart(ch)) {
      keywordRelationalOperator.lastIndex = pos;
      if (keywordRelationalOperator.test(this.input)) {
        // We have seen `in` or `instanceof` so far, now check if the identifier
        // ends here
        const endCh = this.codePointAtPos(keywordRelationalOperator.lastIndex);
        if (!isIdentifierChar(endCh) && endCh !== charCodes.backslash) {
          return false;
        }
      }
      return true;
    } else if (ch === charCodes.backslash) {
      return true;
    } else {
      return false;
    }
  }

  /**
   * 检查字符是否开始绑定模式
   * Check if character starts a binding pattern
   *
   * 检查字符是否为数组或对象绑定模式的开始字符（[ 或 {）。
   *
   * @param ch - 字符码
   * @returns 如果字符开始绑定模式则返回 true
   */
  chStartsBindingPattern(ch: number) {
    return (
      ch === charCodes.leftSquareBracket || ch === charCodes.leftCurlyBrace
    );
  }

  /**
   * Assuming we have seen a contextual `let` and declaration is allowed, check if it
   * starts a variable declaration so that it should be interpreted as a keyword.
   * 假设我们看到了上下文 `let`，并且允许声明，检查它是否
   * 启动了变量声明，因此应该将其解释为关键字。
   */
  hasFollowingBindingAtom(): boolean {
    const next = this.nextTokenStart();
    const nextCh = this.codePointAtPos(next);
    return (
      this.chStartsBindingPattern(nextCh) ||
      this.chStartsBindingIdentifier(nextCh, next)
    );
  }

  /**
   * Assuming we have seen a contextual `using` and declaration is allowed, check if it
   * starts a variable declaration in the same line so that it should be interpreted as
   * a keyword.
   * 假设我们看到了上下文相关的 `using` 并且允许声明，请检查它是否
   * 在同一行中启动了变量声明，因此它应该被解释为
   * 一个关键字。
   */
  hasInLineFollowingBindingIdentifierOrBrace(): boolean {
    const next = this.nextTokenInLineStart();
    const nextCh = this.codePointAtPos(next);
    return (
      nextCh === charCodes.leftCurlyBrace ||
      this.chStartsBindingIdentifier(nextCh, next)
    );
  }

  /**
   * 检查当前作用域是否允许 using 声明
   * Check if current scope allows using declarations
   *
   * using 声明只能在模块中或非顶层作用域中使用，
   * 且不能在裸露的 case 语句中使用。
   *
   * @returns 如果允许 using 声明则返回 true
   */
  allowsUsing(): boolean {
    return (
      (this.scope.inModule || !this.scope.inTopLevel) &&
      !this.scope.inBareCaseStatement
    );
  }

  /**
   * 解析模块项 - 解析模块级别的语句或声明
   * Parse module item - parse module-level statements or declarations
   *
   * 解析模块中的项目，包括 import/export 语句、声明和带标签的函数。
   * 遵循 ECMAScript 规范的 ModuleItem 产生式。
   *
   * @returns 模块项节点
   */
  // https://tc39.es/ecma262/#prod-ModuleItem
  parseModuleItem(this: Parser) {
    return this.parseStatementLike(
      ParseStatementFlag.AllowImportExport |
        ParseStatementFlag.AllowDeclaration |
        ParseStatementFlag.AllowFunctionDeclaration |
        // This function is actually also used to parse StatementItems,
        // which with Annex B enabled allows labeled functions.
        // 此函数实际上也用于解析 StatementItems，
        // 启用 Annex B  后，允许使用带标签的函数。
        ParseStatementFlag.AllowLabeledFunction,
    );
  }

  /**
   * 解析语句列表项 - 解析语句列表中的单个项目
   * Parse statement list item - parse individual item in statement list
   *
   * 解析语句列表中的项目，包括声明、函数声明和其他语句。
   * 遵循 ECMAScript 规范的 StatementListItem 产生式。
   *
   * @returns 语句列表项节点
   */
  // https://tc39.es/ecma262/#prod-StatementListItem
  parseStatementListItem(this: Parser) {
    return this.parseStatementLike(
      ParseStatementFlag.AllowDeclaration |
        ParseStatementFlag.AllowFunctionDeclaration |
        (!this.options.annexB || this.state.strict
          ? 0
          : ParseStatementFlag.AllowLabeledFunction),
    );
  }

  /**
   * 解析语句或松散的 Annex B 函数声明
   * Parse statement or sloppy Annex B function declaration
   *
   * 在非严格模式下，根据 Annex B 规范解析可能的函数声明。
   * 处理在语句位置出现的函数声明的兼容性问题。
   *
   * @param allowLabeledFunction - 是否允许带标签的函数
   * @returns 语句或函数声明节点
   */
  parseStatementOrSloppyAnnexBFunctionDeclaration(
    this: Parser,
    allowLabeledFunction: boolean = false,
  ) {
    let flags: ParseStatementFlag = ParseStatementFlag.StatementOnly;
    if (this.options.annexB && !this.state.strict) {
      flags |= ParseStatementFlag.AllowFunctionDeclaration;
      if (allowLabeledFunction) {
        flags |= ParseStatementFlag.AllowLabeledFunction;
      }
    }
    return this.parseStatementLike(flags);
  }

  // Parse a single statement.
  //
  // If expecting a statement and finding a slash operator, parse a
  // regular expression literal. This is to handle cases like
  // `if (foo) /blah/.exec(foo)`, where looking at the previous token
  // does not help.
  // https://tc39.es/ecma262/#prod-Statement

  // 解析单个语句。
  //
  // 如果期望语句并找到斜杠运算符，则解析为
  // 正则表达式字面量。这是为了处理类似
  // `if (foo) /blah/.exec(foo)` 的情况，在这些情况下，查看前一个标记
  // 并没有什么帮助。
  parseStatement(this: Parser) {
    return this.parseStatementLike(ParseStatementFlag.StatementOnly);
  }

  // ImportDeclaration and ExportDeclaration are also handled here so we can throw recoverable errors
  // when they are not at the top level
  // ImportDeclaration 和 ExportDeclaration 也在这里处理，因此当它们不在顶层时，我们可以抛出可恢复的错误
  parseStatementLike(
    this: Parser,
    flags: ParseStatementFlag,
  ):
    | N.Statement
    | N.Declaration
    | N.ImportDeclaration
    | N.ExportDefaultDeclaration
    | N.ExportNamedDeclaration
    | N.ExportAllDeclaration {
    let decorators: N.Decorator[] | null = null;

    if (this.match(tt.at)) {
      decorators = this.parseDecorators(true);
    }
    return this.parseStatementContent(flags, decorators);
  }

  parseStatementContent(
    this: Parser,
    flags: ParseStatementFlag,
    decorators?: N.Decorator[] | null,
  ): N.Statement {
    const startType = this.state.type;
    const node = this.startNode();
    const allowDeclaration = !!(flags & ParseStatementFlag.AllowDeclaration);
    const allowFunctionDeclaration = !!(
      flags & ParseStatementFlag.AllowFunctionDeclaration
    );
    const topLevel = flags & ParseStatementFlag.AllowImportExport;

    // Most types of statements are recognized by the keyword they
    // start with. Many are trivial to parse, some require a bit of
    // complexity.

    switch (startType) {
      case tt._break:
        return this.parseBreakContinueStatement(node, /* isBreak */ true);
      case tt._continue:
        return this.parseBreakContinueStatement(node, /* isBreak */ false);
      case tt._debugger:
        return this.parseDebuggerStatement(node as Undone<N.DebuggerStatement>);
      case tt._do:
        return this.parseDoWhileStatement(node as Undone<N.DoWhileStatement>);
      case tt._for:
        return this.parseForStatement(node as Undone<N.ForStatement>);
      case tt._function:
        if (this.lookaheadCharCode() === charCodes.dot) break;
        if (!allowFunctionDeclaration) {
          this.raise(
            this.state.strict
              ? Errors.StrictFunction
              : this.options.annexB
                ? Errors.SloppyFunctionAnnexB
                : Errors.SloppyFunction,
            this.state.startLoc,
          );
        }
        return this.parseFunctionStatement(
          node as Undone<N.FunctionDeclaration>,
          false,
          !allowDeclaration && allowFunctionDeclaration,
        );
      case tt._class:
        if (!allowDeclaration) this.unexpected();
        return this.parseClass(
          this.maybeTakeDecorators(
            decorators,
            node as Undone<N.ClassDeclaration>,
          ),
          true,
        );

      case tt._if:
        return this.parseIfStatement(node as Undone<N.IfStatement>);
      case tt._return:
        return this.parseReturnStatement(node as Undone<N.ReturnStatement>);
      case tt._switch:
        return this.parseSwitchStatement(node as Undone<N.SwitchStatement>);
      case tt._throw:
        return this.parseThrowStatement(node as Undone<N.ThrowStatement>);
      case tt._try:
        return this.parseTryStatement(node as Undone<N.TryStatement>);

      case tt._await:
        // [+Await] await [no LineTerminator here] using [no LineTerminator here] BindingList[+Using]
        if (this.isAwaitUsing()) {
          if (!this.allowsUsing()) {
            this.raise(Errors.UnexpectedUsingDeclaration, node);
          } else if (!allowDeclaration) {
            this.raise(Errors.UnexpectedLexicalDeclaration, node);
          } else if (!this.recordAwaitIfAllowed()) {
            this.raise(Errors.AwaitUsingNotInAsyncContext, node);
          }
          this.next(); // eat 'await'
          return this.parseVarStatement(
            node as Undone<N.VariableDeclaration>,
            "await using",
          );
        }
        break;
      case tt._using:
        // using [no LineTerminator here] BindingList[+Using]
        if (
          this.state.containsEsc ||
          !this.hasInLineFollowingBindingIdentifierOrBrace()
        ) {
          break;
        }
        if (!this.allowsUsing()) {
          this.raise(Errors.UnexpectedUsingDeclaration, this.state.startLoc);
        } else if (!allowDeclaration) {
          this.raise(Errors.UnexpectedLexicalDeclaration, this.state.startLoc);
        }
        return this.parseVarStatement(
          node as Undone<N.VariableDeclaration>,
          "using",
        );
      case tt._let: {
        if (this.state.containsEsc) {
          break;
        }
        // `let [` is an explicit negative lookahead for
        // ExpressionStatement, so special-case it first.
        const next = this.nextTokenStart();
        const nextCh = this.codePointAtPos(next);
        if (nextCh !== charCodes.leftSquareBracket) {
          if (!allowDeclaration && this.hasFollowingLineBreak()) break;
          if (
            !this.chStartsBindingIdentifier(nextCh, next) &&
            nextCh !== charCodes.leftCurlyBrace
          ) {
            break;
          }
        }
      }
      // fall through
      case tt._const: {
        if (!allowDeclaration) {
          this.raise(Errors.UnexpectedLexicalDeclaration, this.state.startLoc);
        }
      }
      // fall through
      case tt._var: {
        const kind = this.state.value;
        return this.parseVarStatement(
          node as Undone<N.VariableDeclaration>,
          kind,
        );
      }
      case tt._while:
        return this.parseWhileStatement(node as Undone<N.WhileStatement>);
      case tt._with:
        return this.parseWithStatement(node as Undone<N.WithStatement>);
      case tt.braceL:
        return this.parseBlock();
      case tt.semi:
        return this.parseEmptyStatement(node as Undone<N.EmptyStatement>);
      case tt._import: {
        const nextTokenCharCode = this.lookaheadCharCode();
        if (
          nextTokenCharCode === charCodes.leftParenthesis || // import()
          nextTokenCharCode === charCodes.dot // import.meta
        ) {
          break;
        }
      }
      // fall through
      case tt._export: {
        if (
          !(this.optionFlags & OptionFlags.AllowImportExportEverywhere) &&
          !topLevel
        ) {
          this.raise(Errors.UnexpectedImportExport, this.state.startLoc);
        }

        this.next(); // eat `import`/`export`

        let result;
        if (startType === tt._import) {
          result = this.parseImport(node as Undone<N.ImportDeclaration>);
        } else {
          result = this.parseExport(
            node as Undone<
              | N.ExportAllDeclaration
              | N.ExportDefaultDeclaration
              | N.ExportNamedDeclaration
            >,
            decorators,
          );
        }

        this.assertModuleNodeAllowed(result);

        return result;
      }

      default: {
        if (this.isAsyncFunction()) {
          if (!allowDeclaration) {
            this.raise(
              Errors.AsyncFunctionInSingleStatementContext,
              this.state.startLoc,
            );
          }
          this.next(); // eat 'async'
          return this.parseFunctionStatement(
            node as Undone<N.FunctionDeclaration>,
            true,
            !allowDeclaration && allowFunctionDeclaration,
          );
        }
      }
    }

    // If the statement does not start with a statement keyword or a
    // brace, it's an ExpressionStatement or LabeledStatement. We
    // simply start parsing an expression, and afterwards, if the
    // next token is a colon and the expression was a simple
    // Identifier node, we switch to interpreting it as a label.
    // 如果语句不是以语句关键字或括号开头，则为 ExpressionStatement 或 LabeledStatement。我们
    // 只需开始解析表达式，然后，如果
    // 下一个标记是冒号，并且表达式是一个简单的
    // 标识符节点，则我们将其解释为标签。
    const maybeName = this.state.value;
    const expr = this.parseExpression();

    if (
      tokenIsIdentifier(startType) &&
      expr.type === "Identifier" &&
      this.eat(tt.colon)
    ) {
      return this.parseLabeledStatement(
        node as Undone<N.LabeledStatement>,
        maybeName,
        expr,
        flags,
      );
    } else {
      return this.parseExpressionStatement(
        node as Undone<N.ExpressionStatement>,
        expr,
        decorators,
      );
    }
  }

  assertModuleNodeAllowed(node: N.Node): void {
    if (
      !(this.optionFlags & OptionFlags.AllowImportExportEverywhere) &&
      !this.inModule
    ) {
      this.raise(Errors.ImportOutsideModule, node);
    }
  }

  decoratorsEnabledBeforeExport(): boolean {
    if (this.hasPlugin("decorators-legacy")) return true;
    return (
      this.hasPlugin("decorators") &&
      this.getPluginOption("decorators", "decoratorsBeforeExport") !== false
    );
  }

  // Attach the decorators to the given class.
  // NOTE: This method changes the .start location of the class, and thus
  // can affect comment attachment. Calling it before or after finalizing
  // the class node (and thus finalizing its comments) changes how comments
  // before the `class` keyword or before the final .start location of the
  // class are attached.
  // 将装饰器附加到给定的类。
  // 注意：此方法会更改类的 .start 位置，因此
  // 可能会影响注释的附加。在完成类节点之前或之后调用此方法（从而完成其注释）会更改注释的附加方式。
  // 在 `class` 关键字之前或在类的最终 .start 位置之前
  // 进行附加。
  maybeTakeDecorators<T extends Undone<N.Class>>(
    maybeDecorators: N.Decorator[] | null,
    classNode: T,
    exportNode?: Undone<N.ExportDefaultDeclaration | N.ExportNamedDeclaration>,
  ): T {
    if (maybeDecorators) {
      if (classNode.decorators?.length) {
        // Note: decorators attachment is only attempred multiple times
        // when the class is part of an export declaration.
        if (
          typeof this.getPluginOption(
            "decorators",
            "decoratorsBeforeExport",
          ) !== "boolean"
        ) {
          // If `decoratorsBeforeExport` was set to `true` or `false`, we
          // already threw an error about decorators not being in a valid
          // position.
          this.raise(
            Errors.DecoratorsBeforeAfterExport,
            classNode.decorators[0],
          );
        }
        classNode.decorators.unshift(...maybeDecorators);
      } else {
        classNode.decorators = maybeDecorators;
      }
      this.resetStartLocationFromNode(classNode, maybeDecorators[0]);
      if (exportNode) this.resetStartLocationFromNode(exportNode, classNode);
    }
    return classNode;
  }

  canHaveLeadingDecorator(): boolean {
    return this.match(tt._class);
  }

  parseDecorators(this: Parser, allowExport?: boolean): N.Decorator[] {
    const decorators = [];
    do {
      decorators.push(this.parseDecorator());
    } while (this.match(tt.at));

    if (this.match(tt._export)) {
      if (!allowExport) {
        this.unexpected();
      }

      if (!this.decoratorsEnabledBeforeExport()) {
        this.raise(Errors.DecoratorExportClass, this.state.startLoc);
      }
    } else if (!this.canHaveLeadingDecorator()) {
      throw this.raise(Errors.UnexpectedLeadingDecorator, this.state.startLoc);
    }

    return decorators;
  }

  parseDecorator(this: Parser): N.Decorator {
    this.expectOnePlugin(["decorators", "decorators-legacy"]);

    const node = this.startNode<N.Decorator>();
    this.next();

    if (this.hasPlugin("decorators")) {
      const startLoc = this.state.startLoc;
      let expr: N.Expression;

      if (this.match(tt.parenL)) {
        const startLoc = this.state.startLoc;
        this.next(); // eat '('
        expr = this.parseExpression();
        this.expect(tt.parenR);
        expr = this.wrapParenthesis(startLoc, expr);

        const paramsStartLoc = this.state.startLoc;
        node.expression = this.parseMaybeDecoratorArguments(expr, startLoc);
        if (
          this.getPluginOption("decorators", "allowCallParenthesized") ===
            false &&
          node.expression !== expr
        ) {
          this.raise(
            Errors.DecoratorArgumentsOutsideParentheses,
            paramsStartLoc,
          );
        }
      } else {
        expr = this.parseIdentifier(false);

        while (this.eat(tt.dot)) {
          const node = this.startNodeAt<N.MemberExpression>(startLoc);
          node.object = expr;
          if (this.match(tt.privateName)) {
            this.classScope.usePrivateName(
              this.state.value,
              this.state.startLoc,
            );
            node.property = this.parsePrivateName();
          } else {
            node.property = this.parseIdentifier(true);
          }
          node.computed = false;
          expr = this.finishNode(node, "MemberExpression");
        }

        node.expression = this.parseMaybeDecoratorArguments(expr, startLoc);
      }
    } else {
      node.expression = this.parseExprSubscripts();
    }
    return this.finishNode(node, "Decorator");
  }

  parseMaybeDecoratorArguments(
    this: Parser,
    expr: N.Expression,
    startLoc: Position,
  ): N.Expression {
    if (this.eat(tt.parenL)) {
      const node = this.startNodeAt<N.CallExpression>(startLoc);
      node.callee = expr;
      node.arguments = this.parseCallExpressionArguments();
      this.toReferencedList(node.arguments);
      return this.finishNode(node, "CallExpression");
    }

    return expr;
  }

  /**
   * 解析 break/continue 语句
   * Parse break/continue statement
   *
   * 解析 break 或 continue 语句，包括可选的标签。
   * 验证语句在正确的上下文中使用（循环或 switch）。
   *
   * @param node - 未完成的语句节点
   * @param isBreak - 是否为 break 语句
   * @returns break 或 continue 语句节点
   */
  parseBreakContinueStatement(
    node: Undone<N.Node>,
    isBreak: true,
  ): N.BreakStatement;
  parseBreakContinueStatement(
    node: Undone<N.Node>,
    isBreak: false,
  ): N.ContinueStatement;
  parseBreakContinueStatement(
    node: Undone<N.BreakStatement | N.ContinueStatement>,
    isBreak: boolean,
  ): N.BreakStatement | N.ContinueStatement {
    this.next();

    if (this.isLineTerminator()) {
      node.label = null;
    } else {
      node.label = this.parseIdentifier();
      this.semicolon();
    }

    this.verifyBreakContinue(node, isBreak);

    return this.finishNode(
      node,
      isBreak ? "BreakStatement" : "ContinueStatement",
    );
  }

  /**
   * 验证 break/continue 语句的有效性
   * Verify validity of break/continue statement
   *
   * 检查 break/continue 语句是否在有效的上下文中使用，
   * 包括标签匹配和循环/switch 上下文验证。
   *
   * @param node - break/continue 语句节点
   * @param isBreak - 是否为 break 语句
   */
  verifyBreakContinue(
    node: Undone<N.BreakStatement | N.ContinueStatement>,
    isBreak: boolean,
  ) {
    let i;
    for (i = 0; i < this.state.labels.length; ++i) {
      const lab = this.state.labels[i];
      if (node.label == null || lab.name === node.label.name) {
        if (lab.kind != null && (isBreak || lab.kind === LoopLabelKind.Loop)) {
          break;
        }
        if (node.label && isBreak) break;
      }
    }
    if (i === this.state.labels.length) {
      const type = isBreak ? "BreakStatement" : "ContinueStatement";
      this.raise(Errors.IllegalBreakContinue, node, { type });
    }
  }

  /**
   * 解析 debugger 语句
   * Parse debugger statement
   *
   * 解析 debugger 语句，这是一个简单的调试断点语句。
   *
   * @param node - 未完成的 debugger 语句节点
   * @returns 完成的 debugger 语句节点
   */
  parseDebuggerStatement(
    node: Undone<N.DebuggerStatement>,
  ): N.DebuggerStatement {
    this.next();
    this.semicolon();
    return this.finishNode(node, "DebuggerStatement");
  }

  /**
   * 解析头部表达式 - 解析括号内的表达式
   * Parse header expression - parse expression within parentheses
   *
   * 解析 if、while、for 等语句头部括号内的表达式。
   *
   * @returns 表达式节点
   */
  parseHeaderExpression(this: Parser): N.Expression {
    this.expect(tt.parenL);
    const val = this.parseExpression();
    this.expect(tt.parenR);
    return val;
  }

  /**
   * 解析 do-while 循环语句
   * Parse do-while loop statement
   *
   * 解析 do-while 循环，先执行循环体再检查条件。
   * 管理循环标签和智能管道主题上下文。
   *
   * @param node - 未完成的 do-while 语句节点
   * @returns 完成的 do-while 语句节点
   */
  // https://tc39.es/ecma262/#prod-DoWhileStatement
  parseDoWhileStatement(
    this: Parser,
    node: Undone<N.DoWhileStatement>,
  ): N.DoWhileStatement {
    this.next();
    this.state.labels.push(loopLabel);

    // Parse the loop body's body.
    node.body =
      // For the smartPipelines plugin: Disable topic references from outer
      // contexts within the loop body. They are permitted in test expressions,
      // outside of the loop body.
      this.withSmartMixTopicForbiddingContext(() =>
        // Parse the loop body's body.
        this.parseStatement(),
      );

    this.state.labels.pop();

    this.expect(tt._while);
    node.test = this.parseHeaderExpression();
    this.eat(tt.semi);
    return this.finishNode(node, "DoWhileStatement");
  }

  // Disambiguating between a `for` and a `for`/`in` or `for`/`of`
  // loop is non-trivial. Basically, we have to parse the init `var`
  // statement or expression, disallowing the `in` operator (see
  // the second parameter to `parseExpression`), and then check
  // whether the next token is `in` or `of`. When there is no init
  // part (semicolon immediately after the opening parenthesis), it
  // is a regular `for` loop.

  /**
   * 解析 for 循环语句 - 处理多种 for 循环类型
   * Parse for loop statement - handle multiple types of for loops
   *
   * 解析各种类型的 for 循环：
   * - 标准 for 循环：for (init; test; update)
   * - for-in 循环：for (variable in object)
   * - for-of 循环：for (variable of iterable)
   * - for-await-of 循环：for await (variable of asyncIterable)
   * - for-using 循环：for (using resource of resources)
   *
   * 通过解析初始化部分来区分不同类型的循环。
   *
   * @param node - 未完成的 for 语句节点
   * @returns 完成的 for 循环节点
   */
  parseForStatement(
    this: Parser,
    node: Undone<N.ForStatement | N.ForInOf>,
  ): N.ForLike {
    this.next();
    this.state.labels.push(loopLabel);

    let awaitAt = null;

    if (this.isContextual(tt._await) && this.recordAwaitIfAllowed()) {
      awaitAt = this.state.startLoc;
      this.next();
    }
    this.scope.enter(ScopeFlag.OTHER);
    this.expect(tt.parenL);

    if (this.match(tt.semi)) {
      if (awaitAt !== null) {
        this.unexpected(awaitAt);
      }
      return this.parseFor(node as Undone<N.ForStatement>, null);
    }

    const startsWithLet = this.isContextual(tt._let);
    {
      const startsWithAwaitUsing = this.isAwaitUsing();
      const starsWithUsingDeclaration =
        startsWithAwaitUsing || this.isForUsing();
      const isLetOrUsing =
        (startsWithLet && this.hasFollowingBindingAtom()) ||
        starsWithUsingDeclaration;

      if (this.match(tt._var) || this.match(tt._const) || isLetOrUsing) {
        const initNode = this.startNode<N.VariableDeclaration>();
        let kind;
        if (startsWithAwaitUsing) {
          kind = "await using";
          if (!this.recordAwaitIfAllowed()) {
            this.raise(Errors.AwaitUsingNotInAsyncContext, this.state.startLoc);
          }
          this.next(); // eat 'await'
        } else {
          kind = this.state.value;
        }
        this.next();
        this.parseVar(initNode, true, kind);
        const init = this.finishNode(initNode, "VariableDeclaration");

        const isForIn = this.match(tt._in);
        if (isForIn && starsWithUsingDeclaration) {
          this.raise(Errors.ForInUsing, init);
        }
        if (
          (isForIn || this.isContextual(tt._of)) &&
          init.declarations.length === 1
        ) {
          return this.parseForIn(node as Undone<N.ForInOf>, init, awaitAt);
        }
        if (awaitAt !== null) {
          this.unexpected(awaitAt);
        }
        return this.parseFor(node as Undone<N.ForStatement>, init);
      }
    }

    // Check whether the first token is possibly a contextual keyword, so that
    // we can forbid `for (async of` if this turns out to be a for-of loop.
    const startsWithAsync = this.isContextual(tt._async);

    const refExpressionErrors = new ExpressionErrors();
    const init = this.parseExpression(true, refExpressionErrors);
    const isForOf = this.isContextual(tt._of);
    if (isForOf) {
      // Check for leading tokens that are forbidden in for-of loops:
      if (startsWithLet) {
        this.raise(Errors.ForOfLet, init);
      }

      if (
        // `for await (async of []);` is allowed.
        awaitAt === null &&
        startsWithAsync &&
        init.type === "Identifier"
      ) {
        // This catches the case where the `async` in `for (async of` was
        // parsed as an identifier. If it was parsed as the start of an async
        // arrow function (e.g. `for (async of => {} of []);`), the LVal check
        // further down will raise a more appropriate error.
        this.raise(Errors.ForOfAsync, init);
      }
    }
    if (isForOf || this.match(tt._in)) {
      this.checkDestructuringPrivate(refExpressionErrors);
      this.toAssignable(init, /* isLHS */ true);
      const type = isForOf ? "ForOfStatement" : "ForInStatement";
      this.checkLVal(init, { type });
      return this.parseForIn(
        node as Undone<N.ForInStatement | N.ForOfStatement>,
        // @ts-expect-error init has been transformed to an assignable
        init,
        awaitAt,
      );
    } else {
      this.checkExpressionErrors(refExpressionErrors, true);
    }
    if (awaitAt !== null) {
      this.unexpected(awaitAt);
    }
    return this.parseFor(node as Undone<N.ForStatement>, init);
  }

  /**
   * 解析函数声明语句
   * Parse function declaration statement
   *
   * 解析函数声明，包括普通函数和异步函数。
   * 处理悬挂声明（在单语句上下文中的函数声明）。
   *
   * @param node - 未完成的函数声明节点
   * @param isAsync - 是否为异步函数
   * @param isHangingDeclaration - 是否为悬挂声明
   * @returns 完成的函数声明节点
   */
  // https://tc39.es/ecma262/#prod-HoistableDeclaration
  parseFunctionStatement(
    this: Parser,
    node: Undone<N.FunctionDeclaration>,
    isAsync: boolean,
    isHangingDeclaration: boolean,
  ): N.FunctionDeclaration {
    this.next(); // eat 'function'
    return this.parseFunction(
      node,
      ParseFunctionFlag.Declaration |
        (isHangingDeclaration ? ParseFunctionFlag.HangingDeclaration : 0) |
        (isAsync ? ParseFunctionFlag.Async : 0),
    );
  }

  /**
   * 解析 if 语句
   * Parse if statement
   *
   * 解析 if-else 条件语句，包括测试表达式、then 分支和可选的 else 分支。
   * 支持 Annex B 中的松散函数声明规则。
   *
   * @param node - 未完成的 if 语句节点
   * @returns 完成的 if 语句节点
   */
  // https://tc39.es/ecma262/#prod-IfStatement
  parseIfStatement(this: Parser, node: Undone<N.IfStatement>) {
    this.next();
    node.test = this.parseHeaderExpression();
    // Annex B.3.3
    // https://tc39.es/ecma262/#sec-functiondeclarations-in-ifstatement-statement-clauses
    node.consequent = this.parseStatementOrSloppyAnnexBFunctionDeclaration();
    node.alternate = this.eat(tt._else)
      ? this.parseStatementOrSloppyAnnexBFunctionDeclaration()
      : null;
    return this.finishNode(node, "IfStatement");
  }

  /**
   * 解析 return 语句
   * Parse return statement
   *
   * 解析 return 语句，包括可选的返回值表达式。
   * 验证 return 语句是否在有效的函数上下文中使用。
   *
   * @param node - 未完成的 return 语句节点
   * @returns 完成的 return 语句节点
   */
  parseReturnStatement(this: Parser, node: Undone<N.ReturnStatement>) {
    if (!this.prodParam.hasReturn) {
      this.raise(Errors.IllegalReturn, this.state.startLoc);
    }

    this.next();

    // In `return` (and `break`/`continue`), the keywords with
    // optional arguments, we eagerly look for a semicolon or the
    // possibility to insert one.

    if (this.isLineTerminator()) {
      node.argument = null;
    } else {
      node.argument = this.parseExpression();
      this.semicolon();
    }

    return this.finishNode(node, "ReturnStatement");
  }

  /**
   * 解析 switch 语句
   * Parse switch statement
   *
   * 解析 switch 语句，包括判别表达式和多个 case/default 分支。
   * 管理 switch 标签和作用域，验证不能有多个 default 分支。
   *
   * @param node - 未完成的 switch 语句节点
   * @returns 完成的 switch 语句节点
   */
  // https://tc39.es/ecma262/#prod-SwitchStatement
  parseSwitchStatement(this: Parser, node: Undone<N.SwitchStatement>) {
    this.next();
    node.discriminant = this.parseHeaderExpression();
    const cases: N.SwitchStatement["cases"] = (node.cases = []);
    this.expect(tt.braceL);
    this.state.labels.push(switchLabel);
    this.scope.enter(ScopeFlag.SWITCH);

    // Statements under must be grouped (by label) in SwitchCase
    // nodes. `cur` is used to keep the node that we are currently
    // adding statements to.

    let cur;
    for (let sawDefault; !this.match(tt.braceR); ) {
      if (this.match(tt._case) || this.match(tt._default)) {
        const isCase = this.match(tt._case);
        if (cur) this.finishNode(cur, "SwitchCase");
        // @ts-expect-error Fixme
        cases.push((cur = this.startNode<N.SwitchCase>()));
        cur.consequent = [];
        this.next();
        if (isCase) {
          cur.test = this.parseExpression();
        } else {
          if (sawDefault) {
            this.raise(
              Errors.MultipleDefaultsInSwitch,
              this.state.lastTokStartLoc,
            );
          }
          sawDefault = true;
          cur.test = null;
        }
        this.expect(tt.colon);
      } else {
        if (cur) {
          cur.consequent.push(this.parseStatementListItem());
        } else {
          this.unexpected();
        }
      }
    }
    this.scope.exit();
    if (cur) this.finishNode(cur, "SwitchCase");
    this.next(); // Closing brace
    this.state.labels.pop();
    return this.finishNode(node, "SwitchStatement");
  }

  /**
   * 解析 throw 语句
   * Parse throw statement
   *
   * 解析 throw 语句，包括要抛出的异常表达式。
   * 验证 throw 关键字后不能有换行符。
   *
   * @param node - 未完成的 throw 语句节点
   * @returns 完成的 throw 语句节点
   */
  parseThrowStatement(this: Parser, node: Undone<N.ThrowStatement>) {
    this.next();
    if (this.hasPrecedingLineBreak()) {
      this.raise(Errors.NewlineAfterThrow, this.state.lastTokEndLoc);
    }
    node.argument = this.parseExpression();
    this.semicolon();
    return this.finishNode(node, "ThrowStatement");
  }

  parseCatchClauseParam(this: Parser): N.Pattern {
    const param = this.parseBindingAtom();

    this.scope.enter(
      this.options.annexB && param.type === "Identifier"
        ? ScopeFlag.SIMPLE_CATCH
        : ScopeFlag.OTHER,
    );
    this.checkLVal(
      param,
      { type: "CatchClause" },
      BindingFlag.TYPE_CATCH_PARAM,
    );

    return param;
  }

  parseTryStatement(
    this: Parser,
    node: Undone<N.TryStatement>,
  ): N.TryStatement {
    this.next();

    node.block = this.parseBlock();
    node.handler = null;

    if (this.match(tt._catch)) {
      const clause = this.startNode<N.CatchClause>();
      this.next();
      if (this.match(tt.parenL)) {
        this.expect(tt.parenL);
        clause.param = this.parseCatchClauseParam();
        this.expect(tt.parenR);
      } else {
        clause.param = null;
        this.scope.enter(ScopeFlag.OTHER);
      }

      // Parse the catch clause's body.
      clause.body =
        // For the smartPipelines plugin: Disable topic references from outer
        // contexts within the catch clause's body.
        this.withSmartMixTopicForbiddingContext(() =>
          // Parse the catch clause's body.
          this.parseBlock(false, false),
        );

      this.scope.exit();
      node.handler = this.finishNode(clause, "CatchClause");
    }

    node.finalizer = this.eat(tt._finally) ? this.parseBlock() : null;

    if (!node.handler && !node.finalizer) {
      this.raise(Errors.NoCatchOrFinally, node);
    }

    return this.finishNode(node, "TryStatement");
  }

  // https://tc39.es/ecma262/#prod-VariableStatement
  // https://tc39.es/ecma262/#prod-LexicalDeclaration
  parseVarStatement(
    this: Parser,
    node: Undone<N.VariableDeclaration>,
    kind: "var" | "let" | "const" | "using" | "await using",
    allowMissingInitializer: boolean = false,
  ): N.VariableDeclaration {
    this.next();
    this.parseVar(node, false, kind, allowMissingInitializer);
    this.semicolon();
    return this.finishNode(node, "VariableDeclaration");
  }

  // https://tc39.es/ecma262/#prod-WhileStatement
  parseWhileStatement(
    this: Parser,
    node: Undone<N.WhileStatement>,
  ): N.WhileStatement {
    this.next();
    node.test = this.parseHeaderExpression();
    this.state.labels.push(loopLabel);

    // Parse the loop body.
    node.body =
      // For the smartPipelines plugin:
      // Disable topic references from outer contexts within the loop body.
      // They are permitted in test expressions, outside of the loop body.
      this.withSmartMixTopicForbiddingContext(() =>
        // Parse loop body.
        this.parseStatement(),
      );

    this.state.labels.pop();

    return this.finishNode(node, "WhileStatement");
  }

  parseWithStatement(
    this: Parser,
    node: Undone<N.WithStatement>,
  ): N.WithStatement {
    if (this.state.strict) {
      this.raise(Errors.StrictWith, this.state.startLoc);
    }
    this.next();
    node.object = this.parseHeaderExpression();

    // Parse the statement body.
    node.body =
      // For the smartPipelines plugin:
      // Disable topic references from outer contexts within the with statement's body.
      // They are permitted in function default-parameter expressions, which are
      // part of the outer context, outside of the with statement's body.
      this.withSmartMixTopicForbiddingContext(() =>
        // Parse the statement body.
        this.parseStatement(),
      );

    return this.finishNode(node, "WithStatement");
  }

  parseEmptyStatement(node: Undone<N.EmptyStatement>): N.EmptyStatement {
    this.next();
    return this.finishNode(node, "EmptyStatement");
  }

  // https://tc39.es/ecma262/#prod-LabelledStatement
  parseLabeledStatement(
    this: Parser,
    node: Undone<N.LabeledStatement>,
    maybeName: string,
    expr: N.Identifier,
    flags: ParseStatementFlag,
  ): N.LabeledStatement {
    for (const label of this.state.labels) {
      if (label.name === maybeName) {
        this.raise(Errors.LabelRedeclaration, expr, {
          labelName: maybeName,
        });
      }
    }

    const kind = tokenIsLoop(this.state.type)
      ? LoopLabelKind.Loop
      : this.match(tt._switch)
        ? LoopLabelKind.Switch
        : null;
    for (let i = this.state.labels.length - 1; i >= 0; i--) {
      const label = this.state.labels[i];
      if (label.statementStart === node.start) {
        label.statementStart = this.sourceToOffsetPos(this.state.start);
        label.kind = kind;
      } else {
        break;
      }
    }

    this.state.labels.push({
      name: maybeName,
      kind: kind,
      statementStart: this.sourceToOffsetPos(this.state.start),
    });
    // https://tc39.es/ecma262/#prod-LabelledItem
    node.body =
      flags & ParseStatementFlag.AllowLabeledFunction
        ? this.parseStatementOrSloppyAnnexBFunctionDeclaration(true)
        : this.parseStatement();

    this.state.labels.pop();
    node.label = expr;
    return this.finishNode(node, "LabeledStatement");
  }

  parseExpressionStatement(
    node: Undone<N.ExpressionStatement>,
    expr: N.Expression,
    /* eslint-disable-next-line @typescript-eslint/no-unused-vars -- used in TypeScript parser */
    decorators: N.Decorator[] | null,
  ) {
    node.expression = expr;
    this.semicolon();
    return this.finishNode(node, "ExpressionStatement");
  }

  // Parse a semicolon-enclosed block of statements, handling `"use
  // strict"` declarations when `allowDirectives` is true (used for
  // function bodies).

  parseBlock(
    this: Parser,
    allowDirectives: boolean = false,
    createNewLexicalScope: boolean = true,
    afterBlockParse?: (hasStrictModeDirective: boolean) => void,
  ): N.BlockStatement {
    const node = this.startNode<N.BlockStatement>();
    if (allowDirectives) {
      this.state.strictErrors.clear();
    }
    this.expect(tt.braceL);
    if (createNewLexicalScope) {
      this.scope.enter(ScopeFlag.OTHER);
    }
    this.parseBlockBody(
      node,
      allowDirectives,
      false,
      tt.braceR,
      afterBlockParse,
    );
    if (createNewLexicalScope) {
      this.scope.exit();
    }
    return this.finishNode(node, "BlockStatement");
  }

  isValidDirective(stmt: N.Statement): stmt is N.ExpressionStatement {
    return (
      stmt.type === "ExpressionStatement" &&
      stmt.expression.type === "StringLiteral" &&
      !stmt.expression.extra.parenthesized
    );
  }

  parseBlockBody(
    this: Parser,
    node: Undone<N.BlockStatementLike>,
    allowDirectives: boolean | undefined | null,
    topLevel: boolean,
    end: TokenType,
    afterBlockParse?: (hasStrictModeDirective: boolean) => void,
  ): void {
    const body: N.BlockStatementLike["body"] = (node.body = []);
    const directives: N.BlockStatementLike["directives"] = (node.directives =
      []);
    this.parseBlockOrModuleBlockBody(
      body,
      allowDirectives ? directives : undefined,
      topLevel,
      end,
      afterBlockParse,
    );
  }

  // Undefined directives means that directives are not allowed.
  // https://tc39.es/ecma262/#prod-Block
  // https://tc39.es/ecma262/#prod-ModuleBody
  parseBlockOrModuleBlockBody(
    this: Parser,
    body: N.Statement[],
    directives: N.Directive[] | undefined | null,
    topLevel: boolean,
    end: TokenType,
    afterBlockParse?: (hasStrictModeDirective: boolean) => void,
  ): void {
    const oldStrict = this.state.strict;
    let hasStrictModeDirective = false;
    let parsedNonDirective = false;

    while (!this.match(end)) {
      const stmt = topLevel
        ? this.parseModuleItem()
        : this.parseStatementListItem();

      if (directives && !parsedNonDirective) {
        if (this.isValidDirective(stmt)) {
          const directive = this.stmtToDirective(stmt);
          directives.push(directive);

          if (
            !hasStrictModeDirective &&
            directive.value.value === "use strict"
          ) {
            hasStrictModeDirective = true;
            this.setStrict(true);
          }

          continue;
        }
        parsedNonDirective = true;
        // clear strict errors since the strict mode will not change within the block
        this.state.strictErrors.clear();
      }
      body.push(stmt);
    }

    afterBlockParse?.call(this, hasStrictModeDirective);

    if (!oldStrict) {
      this.setStrict(false);
    }

    this.next();
  }

  // Parse a regular `for` loop. The disambiguation code in
  // `parseStatement` will already have parsed the init statement or
  // expression.

  parseFor(
    this: Parser,
    node: Undone<N.ForStatement>,
    init?: N.VariableDeclaration | N.Expression | null,
  ): N.ForStatement {
    node.init = init;
    this.semicolon(/* allowAsi */ false);
    node.test = this.match(tt.semi) ? null : this.parseExpression();
    this.semicolon(/* allowAsi */ false);
    node.update = this.match(tt.parenR) ? null : this.parseExpression();
    this.expect(tt.parenR);

    // Parse the loop body.
    node.body =
      // For the smartPipelines plugin: Disable topic references from outer
      // contexts within the loop body. They are permitted in test expressions,
      // outside of the loop body.
      this.withSmartMixTopicForbiddingContext(() =>
        // Parse the loop body.
        this.parseStatement(),
      );

    this.scope.exit();
    this.state.labels.pop();

    return this.finishNode(node, "ForStatement");
  }

  // Parse a `for`/`in` and `for`/`of` loop, which are almost
  // same from parser's perspective.

  parseForIn(
    this: Parser,
    node: Undone<N.ForInOf>,
    init: N.VariableDeclaration | N.AssignmentPattern,
    awaitAt?: Position | null,
  ): N.ForInOf {
    const isForIn = this.match(tt._in);
    this.next();

    if (isForIn) {
      if (awaitAt !== null) this.unexpected(awaitAt);
    } else {
      node.await = awaitAt !== null;
    }

    if (
      init.type === "VariableDeclaration" &&
      init.declarations[0].init != null &&
      (!isForIn ||
        !this.options.annexB ||
        this.state.strict ||
        init.kind !== "var" ||
        init.declarations[0].id.type !== "Identifier")
    ) {
      this.raise(Errors.ForInOfLoopInitializer, init, {
        type: isForIn ? "ForInStatement" : "ForOfStatement",
      });
    }

    if (init.type === "AssignmentPattern") {
      this.raise(Errors.InvalidLhs, init, {
        ancestor: { type: "ForStatement" },
      });
    }

    node.left = init;
    node.right = isForIn
      ? this.parseExpression()
      : this.parseMaybeAssignAllowIn();
    this.expect(tt.parenR);

    // Parse the loop body.
    node.body =
      // For the smartPipelines plugin:
      // Disable topic references from outer contexts within the loop body.
      // They are permitted in test expressions, outside of the loop body.
      this.withSmartMixTopicForbiddingContext(() =>
        // Parse loop body.
        this.parseStatement(),
      );

    this.scope.exit();
    this.state.labels.pop();

    return this.finishNode(node, isForIn ? "ForInStatement" : "ForOfStatement");
  }

  // Parse a list of variable declarations.

  parseVar(
    this: Parser,
    node: Undone<N.VariableDeclaration>,
    isFor: boolean,
    kind: "var" | "let" | "const" | "using" | "await using",
    allowMissingInitializer: boolean = false,
  ): Undone<N.VariableDeclaration> {
    const declarations: N.VariableDeclarator[] = (node.declarations = []);
    node.kind = kind;
    for (;;) {
      const decl = this.startNode<N.VariableDeclarator>();
      this.parseVarId(decl, kind);
      decl.init = !this.eat(tt.eq)
        ? null
        : isFor
          ? this.parseMaybeAssignDisallowIn()
          : this.parseMaybeAssignAllowIn();

      if (decl.init === null && !allowMissingInitializer) {
        if (
          decl.id.type !== "Identifier" &&
          !(isFor && (this.match(tt._in) || this.isContextual(tt._of)))
        ) {
          this.raise(
            Errors.DeclarationMissingInitializer,
            this.state.lastTokEndLoc,
            {
              kind: "destructuring",
            },
          );
        } else if (
          (kind === "const" || kind === "using" || kind === "await using") &&
          !(this.match(tt._in) || this.isContextual(tt._of))
        ) {
          this.raise(
            Errors.DeclarationMissingInitializer,
            this.state.lastTokEndLoc,
            { kind },
          );
        }
      }
      declarations.push(this.finishNode(decl, "VariableDeclarator"));
      if (!this.eat(tt.comma)) break;
    }
    return node;
  }

  parseVarId(
    this: Parser,
    decl: Undone<N.VariableDeclarator>,
    kind: "var" | "let" | "const" | "using" | "await using",
  ): void {
    const id = this.parseBindingAtom();
    if (kind === "using" || kind === "await using") {
      if (id.type === "ArrayPattern" || id.type === "ObjectPattern") {
        this.raise(Errors.UsingDeclarationHasBindingPattern, id.loc.start);
      }
    } else {
      if (id.type === "VoidPattern") {
        this.raise(Errors.UnexpectedVoidPattern, id.loc.start);
      }
    }
    this.checkLVal(
      id,
      { type: "VariableDeclarator" },
      kind === "var" ? BindingFlag.TYPE_VAR : BindingFlag.TYPE_LEXICAL,
    );
    decl.id = id;
  }

  // https://tc39.es/ecma262/#prod-AsyncFunctionExpression
  parseAsyncFunctionExpression(
    this: Parser,
    node: Undone<N.FunctionExpression>,
  ): N.FunctionExpression {
    return this.parseFunction(node, ParseFunctionFlag.Async);
  }

  // Parse a function declaration or expression (depending on the
  // ParseFunctionFlag.Declaration flag).

  /**
   * 解析函数 - 通用函数解析方法
   * Parse function - generic function parsing method
   *
   * 解析函数声明或表达式的通用方法，支持：
   * - 普通函数和异步函数
   * - 生成器函数
   * - 函数声明和函数表达式
   * - 可选函数名（匿名函数）
   * - 悬挂声明处理
   *
   * @param node - 未完成的函数节点
   * @param flags - 解析标志位，控制解析模式
   * @returns 完成的函数节点
   */
  parseFunction<T extends N.NormalFunction>(
    this: Parser,
    node: Undone<T>,
    flags: ParseFunctionFlag = ParseFunctionFlag.Expression,
  ): T {
    const hangingDeclaration = flags & ParseFunctionFlag.HangingDeclaration;
    const isDeclaration = !!(flags & ParseFunctionFlag.Declaration);
    const requireId = isDeclaration && !(flags & ParseFunctionFlag.NullableId);
    const isAsync = !!(flags & ParseFunctionFlag.Async);

    this.initFunction(node, isAsync);

    if (this.match(tt.star)) {
      if (hangingDeclaration) {
        this.raise(
          Errors.GeneratorInSingleStatementContext,
          this.state.startLoc,
        );
      }
      this.next(); // eat *
      node.generator = true;
    }

    if (isDeclaration) {
      node.id = this.parseFunctionId(requireId);
    }

    const oldMaybeInArrowParameters = this.state.maybeInArrowParameters;
    this.state.maybeInArrowParameters = false;
    this.scope.enter(ScopeFlag.FUNCTION);
    this.prodParam.enter(functionFlags(isAsync, node.generator));

    if (!isDeclaration) {
      node.id = this.parseFunctionId();
    }

    this.parseFunctionParams(node, /* isConstructor */ false);

    // For the smartPipelines plugin: Disable topic references from outer
    // contexts within the function body. They are permitted in function
    // default-parameter expressions, outside of the function body.
    this.withSmartMixTopicForbiddingContext(() => {
      // Parse the function body.
      this.parseFunctionBodyAndFinish(
        node,
        isDeclaration ? "FunctionDeclaration" : "FunctionExpression",
      );
    });

    this.prodParam.exit();
    this.scope.exit();

    if (isDeclaration && !hangingDeclaration) {
      // We need to register this _after_ parsing the function body
      // because of TypeScript body-less function declarations,
      // which shouldn't be added to the scope.
      this.registerFunctionStatementId(node as T);
    }

    this.state.maybeInArrowParameters = oldMaybeInArrowParameters;
    return node as T;
  }

  parseFunctionId(requireId?: boolean): N.Identifier | undefined | null {
    return requireId || tokenIsIdentifier(this.state.type)
      ? this.parseIdentifier()
      : null;
  }

  parseFunctionParams(
    this: Parser,
    node: Undone<N.Function>,
    isConstructor?: boolean,
  ): void {
    this.expect(tt.parenL);
    this.expressionScope.enter(newParameterDeclarationScope());
    node.params = this.parseBindingList(
      tt.parenR,
      charCodes.rightParenthesis,
      ParseBindingListFlags.IS_FUNCTION_PARAMS |
        (isConstructor ? ParseBindingListFlags.IS_CONSTRUCTOR_PARAMS : 0),
    );

    this.expressionScope.exit();
  }

  registerFunctionStatementId(node: N.Function): void {
    if (!node.id) return;

    // If it is a regular function declaration in sloppy mode, then it is
    // subject to Annex B semantics (BindingFlag.TYPE_FUNCTION). Otherwise, the binding
    // mode depends on properties of the current scope (see
    // treatFunctionsAsVar).
    this.scope.declareName(
      node.id.name,
      !this.options.annexB || this.state.strict || node.generator || node.async
        ? this.scope.treatFunctionsAsVar
          ? BindingFlag.TYPE_VAR
          : BindingFlag.TYPE_LEXICAL
        : BindingFlag.TYPE_FUNCTION,
      node.id.loc.start,
    );
  }

  // Parse a class declaration or literal (depending on the
  // `isStatement` parameter).

  /**
   * 解析类 - 类声明或类表达式
   * Parse class - class declaration or class expression
   *
   * 解析类定义，包括类名、父类、类体等。
   * 类定义总是在严格模式下执行。
   *
   * @param node - 未完成的类节点
   * @param isStatement - 是否为类声明（否则为类表达式）
   * @param optionalId - 类名是否可选
   * @returns 完成的类节点
   */
  parseClass<T extends N.Class>(
    this: Parser,
    node: Undone<T>,
    isStatement: /* T === ClassDeclaration */ boolean,
    optionalId?: boolean,
  ): T {
    this.next(); // 'class'

    // A class definition is always strict mode code.
    const oldStrict = this.state.strict;
    this.state.strict = true;

    this.parseClassId(node, isStatement, optionalId);
    this.parseClassSuper(node);
    // this.state.strict is restored in parseClassBody
    node.body = this.parseClassBody(!!node.superClass, oldStrict);

    return this.finishNode(
      node,
      isStatement ? "ClassDeclaration" : "ClassExpression",
    );
  }

  isClassProperty(): boolean {
    return this.match(tt.eq) || this.match(tt.semi) || this.match(tt.braceR);
  }

  isClassMethod(): boolean {
    return this.match(tt.parenL);
  }

  nameIsConstructor(key: N.Expression | N.PrivateName): boolean {
    return (
      (key.type === "Identifier" && key.name === "constructor") ||
      (key.type === "StringLiteral" && key.value === "constructor")
    );
  }

  isNonstaticConstructor(method: N.ClassMethod | N.ClassProperty): boolean {
    return (
      !method.computed && !method.static && this.nameIsConstructor(method.key)
    );
  }

  /**
   * 解析类体 - 解析类的成员定义
   * Parse class body - parse class member definitions
   *
   * 解析类体中的所有成员，包括：
   * - 方法（普通、静态、私有、异步、生成器）
   * - 属性（普通、静态、私有）
   * - 访问器属性（getter、setter）
   * - 静态初始化块
   * - 装饰器
   *
   * @param hadSuperClass - 是否有父类
   * @param oldStrict - 之前的严格模式状态
   * @returns 完成的类体节点
   */
  // https://tc39.es/ecma262/#prod-ClassBody
  parseClassBody(
    this: Parser,
    hadSuperClass: boolean,
    oldStrict: boolean,
  ): N.ClassBody {
    this.classScope.enter();

    const state: N.ParseClassMemberState = {
      hadConstructor: false,
      hadSuperClass,
    };
    let decorators: N.Decorator[] = [];
    const classBody = this.startNode<N.ClassBody>();
    classBody.body = [];

    this.expect(tt.braceL);

    // For the smartPipelines plugin: Disable topic references from outer
    // contexts within the class body.
    this.withSmartMixTopicForbiddingContext(() => {
      // Parse the contents within the braces.
      while (!this.match(tt.braceR)) {
        if (this.eat(tt.semi)) {
          if (decorators.length > 0) {
            throw this.raise(
              Errors.DecoratorSemicolon,
              this.state.lastTokEndLoc,
            );
          }
          continue;
        }

        if (this.match(tt.at)) {
          decorators.push(this.parseDecorator());
          continue;
        }

        const member = this.startNode<N.ClassMember>();

        // steal the decorators if there are any
        if (decorators.length) {
          // @ts-expect-error Fixme
          member.decorators = decorators;
          this.resetStartLocationFromNode(member, decorators[0]);
          decorators = [];
        }

        this.parseClassMember(classBody, member, state);

        if (
          // @ts-expect-error Fixme
          member.kind === "constructor" &&
          // @ts-expect-error Fixme
          member.decorators &&
          // @ts-expect-error Fixme
          member.decorators.length > 0
        ) {
          this.raise(Errors.DecoratorConstructor, member);
        }
      }
    });

    this.state.strict = oldStrict;

    this.next(); // eat `}`

    if (decorators.length) {
      throw this.raise(Errors.TrailingDecorator, this.state.startLoc);
    }

    this.classScope.exit();

    return this.finishNode(classBody, "ClassBody");
  }

  // returns true if the current identifier is a method/field name,
  // false if it is a modifier
  parseClassMemberFromModifier(
    this: Parser,
    classBody: Undone<N.ClassBody>,
    member: Undone<N.ClassMember>,
  ): boolean {
    const key = this.parseIdentifier(true); // eats the modifier

    if (this.isClassMethod()) {
      const method: N.ClassMethod = member as any;

      // a method named like the modifier
      method.kind = "method";
      method.computed = false;
      method.key = key;
      method.static = false;
      this.pushClassMethod(
        classBody,
        method,
        false,
        false,
        /* isConstructor */ false,
        false,
      );
      return true;
    } else if (this.isClassProperty()) {
      const prop: N.ClassProperty = member as any;

      // a property named like the modifier
      prop.computed = false;
      prop.key = key;
      prop.static = false;
      classBody.body.push(this.parseClassProperty(prop));
      return true;
    }
    this.resetPreviousNodeTrailingComments(key);
    return false;
  }

  parseClassMember(
    this: Parser,
    classBody: Undone<N.ClassBody>,
    member: Undone<N.ClassMember>,
    state: N.ParseClassMemberState,
  ): void {
    const isStatic = this.isContextual(tt._static);

    if (isStatic) {
      if (this.parseClassMemberFromModifier(classBody, member)) {
        // a class element named 'static'
        return;
      }
      if (this.eat(tt.braceL)) {
        this.parseClassStaticBlock(classBody, member as any as N.StaticBlock);
        return;
      }
    }

    this.parseClassMemberWithIsStatic(classBody, member, state, isStatic);
  }

  parseClassMemberWithIsStatic(
    this: Parser,
    classBody: Undone<N.ClassBody>,
    member: Undone<N.ClassMember>,
    state: N.ParseClassMemberState,
    isStatic: boolean,
  ) {
    const publicMethod = member as N.ClassMethod;
    const privateMethod = member as N.ClassPrivateMethod;
    const publicProp = member as N.ClassProperty;
    const privateProp = member as N.ClassPrivateProperty;
    const accessorProp = member as N.ClassAccessorProperty;

    const method: typeof publicMethod | typeof privateMethod = publicMethod;
    const publicMember: typeof publicMethod | typeof publicProp = publicMethod;

    member.static = isStatic;
    this.parsePropertyNamePrefixOperator(member);

    if (this.eat(tt.star)) {
      // a generator
      method.kind = "method";
      const isPrivateName = this.match(tt.privateName);
      this.parseClassElementName(method);
      this.parsePostMemberNameModifiers(method);

      if (isPrivateName) {
        // Private generator method
        this.pushClassPrivateMethod(classBody, privateMethod, true, false);
        return;
      }

      if (this.isNonstaticConstructor(publicMethod)) {
        this.raise(Errors.ConstructorIsGenerator, publicMethod.key);
      }

      this.pushClassMethod(
        classBody,
        publicMethod,
        true,
        false,
        /* isConstructor */ false,
        false,
      );

      return;
    }

    const isContextual =
      !this.state.containsEsc && tokenIsIdentifier(this.state.type);
    const key = this.parseClassElementName(member);
    const maybeContextualKw = isContextual ? (key as N.Identifier).name : null;
    const isPrivate = this.isPrivateName(key);
    const maybeQuestionTokenStartLoc = this.state.startLoc;

    this.parsePostMemberNameModifiers(publicMember);

    if (this.isClassMethod()) {
      method.kind = "method";

      if (isPrivate) {
        this.pushClassPrivateMethod(classBody, privateMethod, false, false);
        return;
      }

      // a normal method
      const isConstructor = this.isNonstaticConstructor(publicMethod);
      let allowsDirectSuper = false;
      if (isConstructor) {
        publicMethod.kind = "constructor";

        // TypeScript allows multiple overloaded constructor declarations.
        if (state.hadConstructor && !this.hasPlugin("typescript")) {
          this.raise(Errors.DuplicateConstructor, key);
        }
        if (isConstructor && this.hasPlugin("typescript") && member.override) {
          this.raise(Errors.OverrideOnConstructor, key);
        }
        state.hadConstructor = true;
        allowsDirectSuper = state.hadSuperClass;
      }

      this.pushClassMethod(
        classBody,
        publicMethod,
        false,
        false,
        isConstructor,
        allowsDirectSuper,
      );
    } else if (this.isClassProperty()) {
      if (isPrivate) {
        this.pushClassPrivateProperty(classBody, privateProp);
      } else {
        this.pushClassProperty(classBody, publicProp);
      }
    } else if (maybeContextualKw === "async" && !this.isLineTerminator()) {
      // an async method
      this.resetPreviousNodeTrailingComments(key);
      const isGenerator = this.eat(tt.star);

      if (publicMember.optional) {
        this.unexpected(maybeQuestionTokenStartLoc);
      }

      method.kind = "method";
      // The so-called parsed name would have been "async": get the real name.
      const isPrivate = this.match(tt.privateName);
      this.parseClassElementName(method);
      this.parsePostMemberNameModifiers(publicMember);

      if (isPrivate) {
        // private async method
        this.pushClassPrivateMethod(
          classBody,
          privateMethod,
          isGenerator,
          true,
        );
      } else {
        if (this.isNonstaticConstructor(publicMethod)) {
          this.raise(Errors.ConstructorIsAsync, publicMethod.key);
        }

        this.pushClassMethod(
          classBody,
          publicMethod,
          isGenerator,
          true,
          /* isConstructor */ false,
          false,
        );
      }
    } else if (
      (maybeContextualKw === "get" || maybeContextualKw === "set") &&
      !(this.match(tt.star) && this.isLineTerminator())
    ) {
      // `get\n*` is an uninitialized property named 'get' followed by a generator.
      // a getter or setter
      this.resetPreviousNodeTrailingComments(key);
      method.kind = maybeContextualKw;
      // The so-called parsed name would have been "get/set": get the real name.
      const isPrivate = this.match(tt.privateName);
      this.parseClassElementName(publicMethod);

      if (isPrivate) {
        // private getter/setter
        this.pushClassPrivateMethod(classBody, privateMethod, false, false);
      } else {
        if (this.isNonstaticConstructor(publicMethod)) {
          this.raise(Errors.ConstructorIsAccessor, publicMethod.key);
        }
        this.pushClassMethod(
          classBody,
          publicMethod,
          false,
          false,
          /* isConstructor */ false,
          false,
        );
      }

      this.checkGetterSetterParams(publicMethod);
    } else if (maybeContextualKw === "accessor" && !this.isLineTerminator()) {
      this.expectPlugin("decoratorAutoAccessors");
      this.resetPreviousNodeTrailingComments(key);

      // The so-called parsed name would have been "accessor": get the real name.
      const isPrivate = this.match(tt.privateName);
      this.parseClassElementName(publicProp);
      this.pushClassAccessorProperty(classBody, accessorProp, isPrivate);
    } else if (this.isLineTerminator()) {
      // an uninitialized class property (due to ASI, since we don't otherwise recognize the next token)
      if (isPrivate) {
        this.pushClassPrivateProperty(classBody, privateProp);
      } else {
        this.pushClassProperty(classBody, publicProp);
      }
    } else {
      this.unexpected();
    }
  }

  // https://tc39.es/ecma262/#prod-ClassElementName
  parseClassElementName(
    this: Parser,
    member: Undone<N.ClassMember>,
  ): N.Expression | N.Identifier | N.PrivateName {
    const { type, value } = this.state;
    if (
      (type === tt.name || type === tt.string) &&
      member.static &&
      value === "prototype"
    ) {
      this.raise(Errors.StaticPrototype, this.state.startLoc);
    }

    if (type === tt.privateName) {
      if (value === "constructor") {
        this.raise(Errors.ConstructorClassPrivateField, this.state.startLoc);
      }
      const key = this.parsePrivateName();
      member.key = key;
      return key;
    }

    this.parsePropertyName(member);
    return member.key;
  }

  parseClassStaticBlock(
    this: Parser,
    classBody: Undone<N.ClassBody>,
    member: Undone<
      N.StaticBlock & {
        decorators?: Array<N.Decorator>;
      }
    >,
  ) {
    // Start a new lexical scope
    this.scope.enter(
      ScopeFlag.CLASS | ScopeFlag.STATIC_BLOCK | ScopeFlag.SUPER,
    );
    // Start a new scope with regard to loop labels
    const oldLabels = this.state.labels;
    this.state.labels = [];
    // ClassStaticBlockStatementList:
    //   StatementList[~Yield, ~Await, ~Return] opt
    this.prodParam.enter(ParamKind.PARAM);
    const body: N.Statement[] = (member.body = []);
    this.parseBlockOrModuleBlockBody(body, undefined, false, tt.braceR);
    this.prodParam.exit();
    this.scope.exit();
    this.state.labels = oldLabels;
    classBody.body.push(this.finishNode<N.StaticBlock>(member, "StaticBlock"));
    if (member.decorators?.length) {
      this.raise(Errors.DecoratorStaticBlock, member);
    }
  }

  pushClassProperty(
    this: Parser,
    classBody: Undone<N.ClassBody>,
    prop: N.ClassProperty,
  ) {
    if (!prop.computed && this.nameIsConstructor(prop.key)) {
      // Non-computed field, which is either an identifier named "constructor"
      // or a string literal named "constructor"
      this.raise(Errors.ConstructorClassField, prop.key);
    }

    classBody.body.push(this.parseClassProperty(prop));
  }

  pushClassPrivateProperty(
    this: Parser,
    classBody: Undone<N.ClassBody>,
    prop: Undone<N.ClassPrivateProperty>,
  ) {
    const node = this.parseClassPrivateProperty(prop);
    classBody.body.push(node);

    this.classScope.declarePrivateName(
      this.getPrivateNameSV(node.key),
      ClassElementType.OTHER,
      node.key.loc.start,
    );
  }

  pushClassAccessorProperty(
    this: Parser,
    classBody: Undone<N.ClassBody>,
    prop: N.ClassAccessorProperty,
    isPrivate: boolean,
  ) {
    if (!isPrivate && !prop.computed && this.nameIsConstructor(prop.key)) {
      // Non-computed field, which is either an identifier named "constructor"
      // or a string literal named "constructor"
      this.raise(Errors.ConstructorClassField, prop.key);
    }

    const node = this.parseClassAccessorProperty(prop);
    classBody.body.push(node);

    if (isPrivate) {
      this.classScope.declarePrivateName(
        this.getPrivateNameSV(node.key as N.PrivateName),
        ClassElementType.OTHER,
        node.key.loc.start,
      );
    }
  }

  pushClassMethod(
    this: Parser,
    classBody: Undone<N.ClassBody>,
    method: Undone<N.ClassMethod>,
    isGenerator: boolean,
    isAsync: boolean,
    isConstructor: boolean,
    allowsDirectSuper: boolean,
  ): void {
    classBody.body.push(
      this.parseMethod(
        method,
        isGenerator,
        isAsync,
        isConstructor,
        allowsDirectSuper,
        "ClassMethod",
        true,
      ),
    );
  }

  pushClassPrivateMethod(
    this: Parser,
    classBody: Undone<N.ClassBody>,
    method: Undone<N.ClassPrivateMethod>,
    isGenerator: boolean,
    isAsync: boolean,
  ): void {
    const node = this.parseMethod(
      method,
      isGenerator,
      isAsync,
      /* isConstructor */ false,
      false,
      "ClassPrivateMethod",
      true,
    );
    classBody.body.push(node);

    const kind =
      node.kind === "get"
        ? node.static
          ? ClassElementType.STATIC_GETTER
          : ClassElementType.INSTANCE_GETTER
        : node.kind === "set"
          ? node.static
            ? ClassElementType.STATIC_SETTER
            : ClassElementType.INSTANCE_SETTER
          : ClassElementType.OTHER;
    this.declareClassPrivateMethodInScope(node, kind);
  }

  declareClassPrivateMethodInScope(
    node: Undone<N.ClassPrivateMethod | N.TSDeclareMethod>,
    kind: number,
  ) {
    this.classScope.declarePrivateName(
      this.getPrivateNameSV(node.key as N.PrivateName),
      kind,
      node.key.loc.start,
    );
  }

  // Overridden in typescript.js
  parsePostMemberNameModifiers(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    methodOrProp: Undone<N.ClassMethod | N.ClassProperty>,
  ): void {}

  // https://tc39.es/ecma262/#prod-FieldDefinition
  parseClassPrivateProperty(
    this: Parser,
    node: Undone<N.ClassPrivateProperty>,
  ): N.ClassPrivateProperty {
    this.parseInitializer(node);
    this.semicolon();
    return this.finishNode(node, "ClassPrivateProperty");
  }

  // https://tc39.es/ecma262/#prod-FieldDefinition
  parseClassProperty(this: Parser, node: N.ClassProperty): N.ClassProperty {
    this.parseInitializer(node);
    this.semicolon();
    return this.finishNode(node, "ClassProperty");
  }

  parseClassAccessorProperty(
    this: Parser,
    node: N.ClassAccessorProperty,
  ): N.ClassAccessorProperty {
    this.parseInitializer(node);
    this.semicolon();
    return this.finishNode(node, "ClassAccessorProperty");
  }

  // https://tc39.es/ecma262/#prod-Initializer
  parseInitializer(
    this: Parser,
    node: Undone<
      N.ClassProperty | N.ClassPrivateProperty | N.ClassAccessorProperty
    >,
  ): void {
    this.scope.enter(ScopeFlag.CLASS | ScopeFlag.SUPER);
    this.expressionScope.enter(newExpressionScope());
    this.prodParam.enter(ParamKind.PARAM);
    node.value = this.eat(tt.eq) ? this.parseMaybeAssignAllowIn() : null;
    this.expressionScope.exit();
    this.prodParam.exit();
    this.scope.exit();
  }

  parseClassId(
    node: Undone<N.Class>,
    isStatement: boolean,
    optionalId?: boolean | null,
    bindingType: BindingFlag = BindingFlag.TYPE_CLASS,
  ): void {
    if (tokenIsIdentifier(this.state.type)) {
      node.id = this.parseIdentifier();
      if (isStatement) {
        this.declareNameFromIdentifier(node.id, bindingType);
      }
    } else {
      if (optionalId || !isStatement) {
        node.id = null;
      } else {
        throw this.raise(Errors.MissingClassName, this.state.startLoc);
      }
    }
  }

  // https://tc39.es/ecma262/#prod-ClassHeritage
  parseClassSuper(this: Parser, node: Undone<N.Class>): void {
    node.superClass = this.eat(tt._extends) ? this.parseExprSubscripts() : null;
  }

  // Parses module export declaration.
  // https://tc39.es/ecma262/#prod-ExportDeclaration

  parseExport(
    this: Parser,
    node: Undone<
      | N.ExportDefaultDeclaration
      | N.ExportAllDeclaration
      | N.ExportNamedDeclaration
    >,
    decorators: N.Decorator[] | null,
  ): N.AnyExport {
    const maybeDefaultIdentifier = this.parseMaybeImportPhase(
      node,
      /* isExport */ true,
    );
    const hasDefault = this.maybeParseExportDefaultSpecifier(
      node,
      maybeDefaultIdentifier,
    );
    const parseAfterDefault = !hasDefault || this.eat(tt.comma);
    const hasStar = parseAfterDefault && this.eatExportStar(node);
    const hasNamespace =
      hasStar && this.maybeParseExportNamespaceSpecifier(node);
    const parseAfterNamespace =
      parseAfterDefault && (!hasNamespace || this.eat(tt.comma));
    const isFromRequired = hasDefault || hasStar;

    if (hasStar && !hasNamespace) {
      if (hasDefault) this.unexpected();
      if (decorators) {
        throw this.raise(Errors.UnsupportedDecoratorExport, node);
      }
      this.parseExportFrom(node, true);

      this.sawUnambiguousESM = true;

      return this.finishNode(node, "ExportAllDeclaration");
    }

    const hasSpecifiers = this.maybeParseExportNamedSpecifiers(node);

    if (hasDefault && parseAfterDefault && !hasStar && !hasSpecifiers) {
      this.unexpected(null, tt.braceL);
    }

    if (hasNamespace && parseAfterNamespace) {
      this.unexpected(null, tt._from);
    }

    let hasDeclaration;
    if (isFromRequired || hasSpecifiers) {
      hasDeclaration = false;
      if (decorators) {
        throw this.raise(Errors.UnsupportedDecoratorExport, node);
      }
      this.parseExportFrom(
        node as Undone<N.ExportNamedDeclaration>,
        isFromRequired,
      );
    } else {
      hasDeclaration = this.maybeParseExportDeclaration(
        node as Undone<N.ExportNamedDeclaration>,
      );
    }

    if (isFromRequired || hasSpecifiers || hasDeclaration) {
      const node2 = node as Undone<N.ExportNamedDeclaration>;
      this.checkExport(node2, true, false, !!node2.source);
      if (node2.declaration?.type === "ClassDeclaration") {
        this.maybeTakeDecorators(decorators, node2.declaration, node2);
      } else if (decorators) {
        throw this.raise(Errors.UnsupportedDecoratorExport, node);
      }
      this.sawUnambiguousESM = true;
      return this.finishNode(node2, "ExportNamedDeclaration");
    }

    if (this.eat(tt._default)) {
      const node2 = node as Undone<N.ExportDefaultDeclaration>;
      // export default ...
      const decl = this.parseExportDefaultExpression();
      node2.declaration = decl;

      if (decl.type === "ClassDeclaration") {
        this.maybeTakeDecorators(decorators, decl as N.ClassDeclaration, node2);
      } else if (decorators) {
        throw this.raise(Errors.UnsupportedDecoratorExport, node);
      }

      this.checkExport(node2, true, true);
      this.sawUnambiguousESM = true;
      return this.finishNode(node2, "ExportDefaultDeclaration");
    }

    this.unexpected(null, tt.braceL);
  }

  eatExportStar(
    node: Undone<N.Node>,
  ): node is Undone<N.ExportNamedDeclaration | N.ExportAllDeclaration> {
    return this.eat(tt.star);
  }

  maybeParseExportDefaultSpecifier(
    node: Undone<
      | N.ExportDefaultDeclaration
      | N.ExportAllDeclaration
      | N.ExportNamedDeclaration
    >,
    maybeDefaultIdentifier: N.Identifier | null,
  ): node is Undone<N.ExportNamedDeclaration> {
    if (maybeDefaultIdentifier || this.isExportDefaultSpecifier()) {
      // export defaultObj ...
      this.expectPlugin("exportDefaultFrom", maybeDefaultIdentifier?.loc.start);
      const id = maybeDefaultIdentifier || this.parseIdentifier(true);
      const specifier = this.startNodeAtNode<N.ExportDefaultSpecifier>(id);
      specifier.exported = id;
      (node as Undone<N.ExportNamedDeclaration>).specifiers = [
        this.finishNode(specifier, "ExportDefaultSpecifier"),
      ];
      return true;
    }
    return false;
  }

  maybeParseExportNamespaceSpecifier(
    node: Undone<N.ExportNamedDeclaration | N.ExportAllDeclaration>,
  ): node is Undone<N.ExportNamedDeclaration> {
    if (this.isContextual(tt._as)) {
      (node as Undone<N.ExportNamedDeclaration>).specifiers ??= [];

      const specifier = this.startNodeAt<N.ExportNamespaceSpecifier>(
        this.state.lastTokStartLoc,
      );

      this.next();

      specifier.exported = this.parseModuleExportName();
      (node as Undone<N.ExportNamedDeclaration>).specifiers.push(
        this.finishNode(specifier, "ExportNamespaceSpecifier"),
      );
      return true;
    }
    return false;
  }

  maybeParseExportNamedSpecifiers(
    node: Undone<N.Node>,
  ): node is Undone<N.ExportNamedDeclaration> {
    if (this.match(tt.braceL)) {
      const node2 = node as Undone<N.ExportNamedDeclaration>;

      if (!node2.specifiers) node2.specifiers = [];
      const isTypeExport = node2.exportKind === "type";
      node2.specifiers.push(...this.parseExportSpecifiers(isTypeExport));
      node2.source = null;
      if (!process.env.BABEL_8_BREAKING && this.hasPlugin("importAssertions")) {
        node2.assertions = [];
      } else {
        node2.attributes = [];
      }
      node2.declaration = null;
      return true;
    }
    return false;
  }

  maybeParseExportDeclaration(
    this: Parser,
    node: Undone<N.ExportNamedDeclaration>,
  ): boolean {
    if (this.shouldParseExportDeclaration()) {
      node.specifiers = [];
      node.source = null;
      if (!process.env.BABEL_8_BREAKING && this.hasPlugin("importAssertions")) {
        node.assertions = [];
      } else {
        node.attributes = [];
      }
      node.declaration = this.parseExportDeclaration(node);
      return true;
    }
    return false;
  }

  isAsyncFunction(): boolean {
    if (!this.isContextual(tt._async)) return false;
    const next = this.nextTokenInLineStart();
    return this.isUnparsedContextual(next, "function");
  }

  parseExportDefaultExpression(
    this: Parser,
  ): N.ExportDefaultDeclaration["declaration"] {
    const expr = this.startNode();

    if (this.match(tt._function)) {
      this.next();
      return this.parseFunction(
        expr as Undone<N.FunctionDeclaration>,
        ParseFunctionFlag.Declaration | ParseFunctionFlag.NullableId,
      );
    } else if (this.isAsyncFunction()) {
      this.next(); // eat 'async'
      this.next(); // eat 'function'
      return this.parseFunction(
        expr as Undone<N.FunctionDeclaration>,
        ParseFunctionFlag.Declaration |
          ParseFunctionFlag.NullableId |
          ParseFunctionFlag.Async,
      );
    }

    if (this.match(tt._class)) {
      return this.parseClass(expr as Undone<N.ClassExpression>, true, true);
    }

    if (this.match(tt.at)) {
      if (
        this.hasPlugin("decorators") &&
        this.getPluginOption("decorators", "decoratorsBeforeExport") === true
      ) {
        this.raise(Errors.DecoratorBeforeExport, this.state.startLoc);
      }
      return this.parseClass(
        this.maybeTakeDecorators(
          this.parseDecorators(false),
          this.startNode<N.ClassDeclaration>(),
        ),
        true,
        true,
      );
    }

    if (
      this.match(tt._const) ||
      this.match(tt._var) ||
      this.isLet() ||
      this.isUsing() ||
      this.isAwaitUsing()
    ) {
      throw this.raise(Errors.UnsupportedDefaultExport, this.state.startLoc);
    }

    const res = this.parseMaybeAssignAllowIn();
    this.semicolon();
    return res;
  }

  // https://tc39.es/ecma262/#prod-ExportDeclaration
  parseExportDeclaration(
    this: Parser,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    node: Undone<N.ExportNamedDeclaration>,
  ): N.Declaration | undefined | null {
    if (this.match(tt._class)) {
      const node = this.parseClass(
        this.startNode<N.ClassDeclaration>(),
        true,
        false,
      );
      return node;
    }
    return this.parseStatementListItem() as N.Declaration;
  }

  isExportDefaultSpecifier(): boolean {
    const { type } = this.state;
    if (tokenIsIdentifier(type)) {
      if ((type === tt._async && !this.state.containsEsc) || type === tt._let) {
        return false;
      }
      if (
        (type === tt._type || type === tt._interface) &&
        !this.state.containsEsc
      ) {
        // If we see any variable name other than `from` after `type` keyword,
        // we consider it as flow/typescript type exports
        // note that this approach may fail on some pedantic cases
        // export type from = number
        const next = this.nextTokenStart();
        const nextChar = this.input.charCodeAt(next);
        if (
          nextChar === charCodes.leftCurlyBrace ||
          (this.chStartsBindingIdentifier(nextChar, next) &&
            !this.input.startsWith("from", next))
        ) {
          this.expectOnePlugin(["flow", "typescript"]);
          return false;
        }
      }
    } else if (!this.match(tt._default)) {
      return false;
    }

    const next = this.nextTokenStart();
    const hasFrom = this.isUnparsedContextual(next, "from");
    if (
      this.input.charCodeAt(next) === charCodes.comma ||
      (tokenIsIdentifier(this.state.type) && hasFrom)
    ) {
      return true;
    }
    // lookahead again when `export default from` is seen
    if (this.match(tt._default) && hasFrom) {
      const nextAfterFrom = this.input.charCodeAt(
        this.nextTokenStartSince(next + 4),
      );
      return (
        nextAfterFrom === charCodes.quotationMark ||
        nextAfterFrom === charCodes.apostrophe
      );
    }
    return false;
  }

  parseExportFrom(
    this: Parser,
    node: Undone<N.ExportNamedDeclaration | N.ExportAllDeclaration>,
    expect?: boolean,
  ): void {
    if (this.eatContextual(tt._from)) {
      node.source = this.parseImportSource();
      this.checkExport(node);
      this.maybeParseImportAttributes(node);
      this.checkJSONModuleImport(node);
    } else if (expect) {
      this.unexpected();
    }

    this.semicolon();
  }

  shouldParseExportDeclaration(): boolean {
    const { type } = this.state;
    if (type === tt.at) {
      this.expectOnePlugin(["decorators", "decorators-legacy"]);
      if (this.hasPlugin("decorators")) {
        if (
          this.getPluginOption("decorators", "decoratorsBeforeExport") === true
        ) {
          this.raise(Errors.DecoratorBeforeExport, this.state.startLoc);
        }

        return true;
      }
    }

    if (this.isUsing()) {
      this.raise(Errors.UsingDeclarationExport, this.state.startLoc);
      return true;
    }

    if (this.isAwaitUsing()) {
      this.raise(Errors.UsingDeclarationExport, this.state.startLoc);
      return true;
    }

    return (
      type === tt._var ||
      type === tt._const ||
      type === tt._function ||
      type === tt._class ||
      this.isLet() ||
      this.isAsyncFunction()
    );
  }

  checkExport(
    node: Undone<
      | N.ExportNamedDeclaration
      | N.ExportAllDeclaration
      | N.ExportDefaultDeclaration
    >,
    checkNames?: boolean,
    isDefault?: boolean,
    isFrom?: boolean,
  ): void {
    if (checkNames) {
      // Check for duplicate exports
      if (isDefault) {
        // Default exports
        this.checkDuplicateExports(node, "default");
        if (this.hasPlugin("exportDefaultFrom")) {
          const declaration = (node as any as N.ExportDefaultDeclaration)
            .declaration;
          if (
            declaration.type === "Identifier" &&
            declaration.name === "from" &&
            declaration.end - declaration.start === 4 && // does not contain escape
            !declaration.extra?.parenthesized
          ) {
            this.raise(Errors.ExportDefaultFromAsIdentifier, declaration);
          }
        }
        // @ts-expect-error node.specifiers may not exist
      } else if (node.specifiers?.length) {
        // Named exports
        // @ts-expect-error node.specifiers may not exist
        for (const specifier of node.specifiers) {
          const { exported } = specifier;
          const exportName =
            exported.type === "Identifier" ? exported.name : exported.value;
          this.checkDuplicateExports(specifier, exportName);
          if (!isFrom && specifier.local) {
            const { local } = specifier;
            if (local.type !== "Identifier") {
              this.raise(Errors.ExportBindingIsString, specifier, {
                localName: local.value,
                exportName,
              });
            } else {
              // check for keywords used as local names
              this.checkReservedWord(local.name, local.loc.start, true, false);
              // check if export is defined
              this.scope.checkLocalExport(local);
            }
          }
        }
      } else if ((node as Undone<N.ExportNamedDeclaration>).declaration) {
        const decl = (node as Undone<N.ExportNamedDeclaration>).declaration;
        // Exported declarations
        if (
          decl.type === "FunctionDeclaration" ||
          decl.type === "ClassDeclaration"
        ) {
          const { id } = decl;
          if (!id) throw new Error("Assertion failure");

          this.checkDuplicateExports(node, id.name);
        } else if (decl.type === "VariableDeclaration") {
          for (const declaration of decl.declarations) {
            this.checkDeclaration(declaration.id);
          }
        }
      }
    }
  }

  checkDeclaration(node: N.Pattern | N.ObjectProperty): void {
    if (node.type === "Identifier") {
      this.checkDuplicateExports(node, node.name);
    } else if (node.type === "ObjectPattern") {
      for (const prop of node.properties) {
        this.checkDeclaration(prop);
      }
    } else if (node.type === "ArrayPattern") {
      for (const elem of node.elements) {
        if (elem) {
          this.checkDeclaration(elem);
        }
      }
    } else if (node.type === "ObjectProperty") {
      // @ts-expect-error migrate to Babel types
      this.checkDeclaration(node.value);
    } else if (node.type === "RestElement") {
      this.checkDeclaration(node.argument);
    } else if (node.type === "AssignmentPattern") {
      this.checkDeclaration(node.left);
    }
  }

  checkDuplicateExports(
    node: Undone<
      | N.Identifier
      | N.StringLiteral
      | N.ExportNamedDeclaration
      | N.ExportSpecifier
      | N.ExportDefaultSpecifier
    >,
    exportName: string,
  ): void {
    if (this.exportedIdentifiers.has(exportName)) {
      if (exportName === "default") {
        this.raise(Errors.DuplicateDefaultExport, node);
      } else {
        this.raise(Errors.DuplicateExport, node, { exportName });
      }
    }
    this.exportedIdentifiers.add(exportName);
  }

  // Parses a comma-separated list of module exports.

  parseExportSpecifiers(isInTypeExport: boolean): Array<N.ExportSpecifier> {
    const nodes = [];
    let first = true;

    // export { x, y as z } [from '...']
    this.expect(tt.braceL);

    while (!this.eat(tt.braceR)) {
      if (first) {
        first = false;
      } else {
        this.expect(tt.comma);
        if (this.eat(tt.braceR)) break;
      }
      const isMaybeTypeOnly = this.isContextual(tt._type);
      const isString = this.match(tt.string);
      const node = this.startNode<N.ExportSpecifier>();
      node.local = this.parseModuleExportName() as N.Identifier;
      nodes.push(
        this.parseExportSpecifier(
          node,
          isString,
          isInTypeExport,
          isMaybeTypeOnly,
        ),
      );
    }

    return nodes;
  }

  parseExportSpecifier(
    node: any,
    isString: boolean,
    /* eslint-disable @typescript-eslint/no-unused-vars -- used in TypeScript parser */
    isInTypeExport: boolean,
    isMaybeTypeOnly: boolean,
    /* eslint-enable @typescript-eslint/no-unused-vars */
  ): N.ExportSpecifier {
    if (this.eatContextual(tt._as)) {
      node.exported = this.parseModuleExportName();
    } else if (isString) {
      node.exported = this.cloneStringLiteral(node.local);
    } else if (!node.exported) {
      node.exported = this.cloneIdentifier(node.local);
    }
    return this.finishNode<N.ExportSpecifier>(node, "ExportSpecifier");
  }

  // https://tc39.es/ecma262/#prod-ModuleExportName
  parseModuleExportName(): N.StringLiteral | N.Identifier {
    if (this.match(tt.string)) {
      const result = this.parseStringLiteral(this.state.value);
      const surrogate = loneSurrogate.exec(result.value);
      if (surrogate) {
        this.raise(Errors.ModuleExportNameHasLoneSurrogate, result, {
          surrogateCharCode: surrogate[0].charCodeAt(0),
        });
      }
      return result;
    }
    return this.parseIdentifier(true);
  }

  isJSONModuleImport(
    node: Undone<
      N.ExportAllDeclaration | N.ExportNamedDeclaration | N.ImportDeclaration
    >,
  ): boolean {
    if (node.assertions != null) {
      return node.assertions.some(({ key, value }) => {
        return (
          value.value === "json" &&
          (key.type === "Identifier"
            ? key.name === "type"
            : key.value === "type")
        );
      });
    }
    return false;
  }

  checkImportReflection(node: Undone<N.ImportDeclaration>) {
    const { specifiers } = node;
    const singleBindingType =
      specifiers.length === 1 ? specifiers[0].type : null;

    if (node.phase === "source") {
      if (singleBindingType !== "ImportDefaultSpecifier") {
        this.raise(
          Errors.SourcePhaseImportRequiresDefault,
          specifiers[0].loc.start,
        );
      }
    } else if (node.phase === "defer") {
      if (singleBindingType !== "ImportNamespaceSpecifier") {
        this.raise(
          Errors.DeferImportRequiresNamespace,
          specifiers[0].loc.start,
        );
      }
    } else if (node.module) {
      if (singleBindingType !== "ImportDefaultSpecifier") {
        this.raise(Errors.ImportReflectionNotBinding, specifiers[0].loc.start);
      }
      if (node.assertions?.length > 0) {
        this.raise(
          Errors.ImportReflectionHasAssertion,
          specifiers[0].loc.start,
        );
      }
    }
  }

  checkJSONModuleImport(
    node: Undone<
      N.ExportAllDeclaration | N.ExportNamedDeclaration | N.ImportDeclaration
    >,
  ) {
    // @ts-expect-error Fixme: node.type must be undefined because they are undone
    if (this.isJSONModuleImport(node) && node.type !== "ExportAllDeclaration") {
      // @ts-expect-error specifiers may not index node
      const { specifiers } = node;
      if (specifiers != null) {
        // @ts-expect-error refine specifier types
        const nonDefaultNamedSpecifier = specifiers.find(specifier => {
          let imported;
          if (specifier.type === "ExportSpecifier") {
            imported = specifier.local;
          } else if (specifier.type === "ImportSpecifier") {
            imported = specifier.imported;
          }
          if (imported !== undefined) {
            return imported.type === "Identifier"
              ? imported.name !== "default"
              : imported.value !== "default";
          }
        });
        if (nonDefaultNamedSpecifier !== undefined) {
          this.raise(
            Errors.ImportJSONBindingNotDefault,
            nonDefaultNamedSpecifier.loc.start,
          );
        }
      }
    }
  }

  isPotentialImportPhase(isExport: boolean): boolean {
    if (isExport) return false;
    return (
      this.isContextual(tt._source) ||
      this.isContextual(tt._defer) ||
      (!process.env.BABEL_8_BREAKING && this.isContextual(tt._module))
    );
  }

  applyImportPhase(
    node: Undone<N.ImportDeclaration | N.ExportNamedDeclaration>,
    isExport: boolean,
    phase: string | null,
    loc?: Position,
  ): void {
    if (isExport) {
      if (!process.env.IS_PUBLISH) {
        if (
          (!process.env.BABEL_8_BREAKING && phase === "module") ||
          phase === "source"
        ) {
          throw new Error(
            `Assertion failure: export declarations do not support the '${phase}' phase.`,
          );
        }
      }
      return;
    }

    if (!process.env.BABEL_8_BREAKING && phase === "module") {
      this.expectPlugin("importReflection", loc);
      (node as N.ImportDeclaration).module = true;
    } else if (this.hasPlugin("importReflection")) {
      (node as N.ImportDeclaration).module = false;
    }

    if (phase === "source") {
      this.expectPlugin("sourcePhaseImports", loc);
      (node as N.ImportDeclaration).phase = "source";
    } else if (phase === "defer") {
      this.expectPlugin("deferredImportEvaluation", loc);
      (node as N.ImportDeclaration).phase = "defer";
    } else if (this.hasPlugin("sourcePhaseImports")) {
      (node as N.ImportDeclaration).phase = null;
    }
  }

  /*
   * Parse `source` in `import source x from "x"`, disambiguating
   * `import source from "x"` and `import source from from "x"`.
   *
   * This function might return an identifier representing the `source`
   * if it eats `source` and then discovers that it was the default import
   * binding and not the import reflection.
   *
   * This function is also used to parse `import type` and `import typeof`
   * in the TS and Flow plugins, and for parsing `import defer`.
   */
  parseMaybeImportPhase(
    node: Undone<N.ImportDeclaration | N.TsImportEqualsDeclaration>,
    isExport: boolean,
  ): N.Identifier | null {
    if (!this.isPotentialImportPhase(isExport)) {
      this.applyImportPhase(
        node as Undone<N.ImportDeclaration>,
        isExport,
        null,
      );
      return null;
    }

    const phaseIdentifier = this.startNode<N.Identifier>();
    const phaseIdentifierName = this.parseIdentifierName(true);

    const { type } = this.state;
    const isImportPhase = tokenIsKeywordOrIdentifier(type)
      ? // OK: import <phase> x from "foo";
        // OK: import <phase> from from "foo";
        // NO: import <phase> from "foo";
        // NO: import <phase> from 'foo';
        // With the module declarations proposals, we will need further disambiguation
        // for `import module from from;`.
        type !== tt._from || this.lookaheadCharCode() === charCodes.lowercaseF
      : // OK: import <phase> { x } from "foo";
        // OK: import <phase> x from "foo";
        // OK: import <phase> * as T from "foo";
        // NO: import <phase> from "foo";
        // OK: import <phase> "foo";
        // The last one is invalid, we will continue parsing and throw
        // an error later
        type !== tt.comma;

    if (isImportPhase) {
      this.applyImportPhase(
        node as Undone<N.ImportDeclaration>,
        isExport,
        phaseIdentifierName,
        phaseIdentifier.loc.start,
      );
      return null;
    } else {
      this.applyImportPhase(
        node as Undone<N.ImportDeclaration>,
        isExport,
        null,
      );
      // `<phase>` is a default binding, return it to the main import declaration parser
      return this.createIdentifier(phaseIdentifier, phaseIdentifierName);
    }
  }

  isPrecedingIdImportPhase(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    phase: string,
  ) {
    const { type } = this.state;
    return tokenIsIdentifier(type)
      ? // OK: import <phase> x from "foo";
        // OK: import <phase> from from "foo";
        // NO: import <phase> from "foo";
        // NO: import <phase> from 'foo';
        // With the module declarations proposals, we will need further disambiguation
        // for `import module from from;`.
        type !== tt._from || this.lookaheadCharCode() === charCodes.lowercaseF
      : // OK: import <phase> { x } from "foo";
        // OK: import <phase> x from "foo";
        // OK: import <phase> * as T from "foo";
        // NO: import <phase> from "foo";
        // OK: import <phase> "foo";
        // The last one is invalid, we will continue parsing and throw
        // an error later
        type !== tt.comma;
  }

  // Parses import declaration.
  // https://tc39.es/ecma262/#prod-ImportDeclaration

  parseImport(this: Parser, node: Undone<N.ImportDeclaration>): N.AnyImport {
    if (this.match(tt.string)) {
      // import '...'
      return this.parseImportSourceAndAttributes(node);
    }

    return this.parseImportSpecifiersAndAfter(
      node,
      this.parseMaybeImportPhase(node, /* isExport */ false),
    );
  }

  parseImportSpecifiersAndAfter(
    this: Parser,
    node: Undone<N.ImportDeclaration>,
    maybeDefaultIdentifier: N.Identifier | null,
  ): N.AnyImport {
    node.specifiers = [];

    // check if we have a default import like
    // import React from "react";
    const hasDefault = this.maybeParseDefaultImportSpecifier(
      node,
      maybeDefaultIdentifier,
    );
    /* we are checking if we do not have a default import, then it is obvious that we need named imports
     * import { get } from "axios";
     * but if we do have a default import
     * we need to check if we have a comma after that and
     * that is where this `|| this.eat` condition comes into play
     */
    const parseNext = !hasDefault || this.eat(tt.comma);
    // if we do have to parse the next set of specifiers, we first check for star imports
    // import React, * from "react";
    const hasStar = parseNext && this.maybeParseStarImportSpecifier(node);
    // now we check if we need to parse the next imports
    // but only if they are not importing * (everything)
    if (parseNext && !hasStar) this.parseNamedImportSpecifiers(node);
    this.expectContextual(tt._from);

    return this.parseImportSourceAndAttributes(node);
  }

  parseImportSourceAndAttributes(
    this: Parser,
    node: Undone<N.ImportDeclaration>,
  ): N.AnyImport {
    node.specifiers ??= [];
    node.source = this.parseImportSource();
    this.maybeParseImportAttributes(node);
    this.checkImportReflection(node);
    this.checkJSONModuleImport(node);

    this.semicolon();
    this.sawUnambiguousESM = true;
    return this.finishNode(node, "ImportDeclaration");
  }

  parseImportSource(this: Parser): N.StringLiteral {
    if (!this.match(tt.string)) this.unexpected();
    return this.parseExprAtom() as N.StringLiteral;
  }

  parseImportSpecifierLocal<
    T extends
      | N.ImportSpecifier
      | N.ImportDefaultSpecifier
      | N.ImportNamespaceSpecifier,
  >(
    node: Undone<N.ImportDeclaration>,
    specifier: Undone<T>,
    type: T["type"],
  ): void {
    specifier.local = this.parseIdentifier();
    node.specifiers.push(this.finishImportSpecifier(specifier, type));
  }

  finishImportSpecifier<
    T extends
      | N.ImportSpecifier
      | N.ImportDefaultSpecifier
      | N.ImportNamespaceSpecifier,
  >(
    specifier: Undone<T>,
    type: T["type"],
    bindingType: BindingFlag = BindingFlag.TYPE_LEXICAL,
  ) {
    this.checkLVal(specifier.local, { type }, bindingType);
    return this.finishNode(specifier, type);
  }

  /**
   * parse assert entries
   *
   * @see {@link https://tc39.es/proposal-import-attributes/#prod-WithEntries WithEntries}
   */
  parseImportAttributes(): N.ImportAttribute[] {
    this.expect(tt.braceL);

    const attrs = [];
    const attrNames = new Set();

    do {
      if (this.match(tt.braceR)) {
        break;
      }

      const node = this.startNode<N.ImportAttribute>();

      // parse AssertionKey : IdentifierName, StringLiteral
      const keyName = this.state.value;
      // check if we already have an entry for an attribute
      // if a duplicate entry is found, throw an error
      // for now this logic will come into play only when someone declares `type` twice
      if (attrNames.has(keyName)) {
        this.raise(
          Errors.ModuleAttributesWithDuplicateKeys,
          this.state.startLoc,
          {
            key: keyName,
          },
        );
      }
      attrNames.add(keyName);
      if (this.match(tt.string)) {
        node.key = this.parseStringLiteral(keyName);
      } else {
        node.key = this.parseIdentifier(true);
      }
      this.expect(tt.colon);

      if (!this.match(tt.string)) {
        throw this.raise(
          Errors.ModuleAttributeInvalidValue,
          this.state.startLoc,
        );
      }
      node.value = this.parseStringLiteral(this.state.value);
      attrs.push(this.finishNode(node, "ImportAttribute"));
    } while (this.eat(tt.comma));

    this.expect(tt.braceR);

    return attrs;
  }

  /**
   * parse module attributes
   * @deprecated It will be removed in Babel 8
   */
  parseModuleAttributes() {
    const attrs: N.ImportAttribute[] = [];
    const attributes = new Set();
    do {
      const node = this.startNode<N.ImportAttribute>();
      node.key = this.parseIdentifier(true);

      if (node.key.name !== "type") {
        this.raise(Errors.ModuleAttributeDifferentFromType, node.key);
      }

      if (attributes.has(node.key.name)) {
        this.raise(Errors.ModuleAttributesWithDuplicateKeys, node.key, {
          key: node.key.name,
        });
      }
      attributes.add(node.key.name);
      this.expect(tt.colon);
      if (!this.match(tt.string)) {
        throw this.raise(
          Errors.ModuleAttributeInvalidValue,
          this.state.startLoc,
        );
      }
      node.value = this.parseStringLiteral(this.state.value);
      attrs.push(this.finishNode(node, "ImportAttribute"));
    } while (this.eat(tt.comma));

    return attrs;
  }

  maybeParseImportAttributes(
    node: Undone<
      N.ImportDeclaration | N.ExportNamedDeclaration | N.ExportAllDeclaration
    >,
  ) {
    let attributes: N.ImportAttribute[];
    if (!process.env.BABEL_8_BREAKING) {
      // eslint-disable-next-line no-var
      var useWith = false;
    }

    // https://tc39.es/proposal-import-attributes/#prod-WithClause
    if (this.match(tt._with)) {
      if (
        this.hasPrecedingLineBreak() &&
        this.lookaheadCharCode() === charCodes.leftParenthesis
      ) {
        // This will be parsed as a with statement, and we will throw a
        // better error about it not being supported in strict mode.
        return;
      }

      this.next(); // eat `with`

      if (!process.env.BABEL_8_BREAKING && this.hasPlugin("moduleAttributes")) {
        attributes = this.parseModuleAttributes();
        this.addExtra(node, "deprecatedWithLegacySyntax", true);
      } else {
        attributes = this.parseImportAttributes();
      }
      if (!process.env.BABEL_8_BREAKING) {
        useWith = true;
      }
    } else if (this.isContextual(tt._assert) && !this.hasPrecedingLineBreak()) {
      if (
        !this.hasPlugin("deprecatedImportAssert") &&
        (process.env.BABEL_8_BREAKING || !this.hasPlugin("importAssertions"))
      ) {
        this.raise(Errors.ImportAttributesUseAssert, this.state.startLoc);
      }
      if (process.env.BABEL_8_BREAKING || !this.hasPlugin("importAssertions")) {
        this.addExtra(node, "deprecatedAssertSyntax", true);
      }
      this.next(); // eat `assert`
      attributes = this.parseImportAttributes();
    } else {
      attributes = [];
    }

    if (
      !process.env.BABEL_8_BREAKING &&
      !useWith &&
      this.hasPlugin("importAssertions")
    ) {
      node.assertions = attributes;
    } else {
      node.attributes = attributes;
    }
  }

  maybeParseDefaultImportSpecifier(
    node: Undone<N.ImportDeclaration>,
    maybeDefaultIdentifier: N.Identifier | null,
  ): boolean {
    // import defaultObj, { x, y as z } from '...'
    if (maybeDefaultIdentifier) {
      const specifier = this.startNodeAtNode<N.ImportDefaultSpecifier>(
        maybeDefaultIdentifier,
      );
      specifier.local = maybeDefaultIdentifier;
      node.specifiers.push(
        this.finishImportSpecifier(specifier, "ImportDefaultSpecifier"),
      );
      return true;
    } else if (
      // We allow keywords, and parseImportSpecifierLocal will report a recoverable error
      tokenIsKeywordOrIdentifier(this.state.type)
    ) {
      this.parseImportSpecifierLocal(
        node,
        this.startNode<N.ImportDefaultSpecifier>(),
        "ImportDefaultSpecifier",
      );
      return true;
    }
    return false;
  }

  maybeParseStarImportSpecifier(node: Undone<N.ImportDeclaration>): boolean {
    if (this.match(tt.star)) {
      const specifier = this.startNode<N.ImportNamespaceSpecifier>();
      this.next();
      this.expectContextual(tt._as);

      this.parseImportSpecifierLocal(
        node,
        specifier,
        "ImportNamespaceSpecifier",
      );
      return true;
    }
    return false;
  }

  parseNamedImportSpecifiers(node: Undone<N.ImportDeclaration>) {
    let first = true;
    this.expect(tt.braceL);
    while (!this.eat(tt.braceR)) {
      if (first) {
        first = false;
      } else {
        // Detect an attempt to deep destructure
        if (this.eat(tt.colon)) {
          throw this.raise(Errors.DestructureNamedImport, this.state.startLoc);
        }

        this.expect(tt.comma);
        if (this.eat(tt.braceR)) break;
      }

      const specifier = this.startNode<N.ImportSpecifier>();
      const importedIsString = this.match(tt.string);
      const isMaybeTypeOnly = this.isContextual(tt._type);
      specifier.imported = this.parseModuleExportName();
      const importSpecifier = this.parseImportSpecifier(
        specifier,
        importedIsString,
        node.importKind === "type" || node.importKind === "typeof",
        isMaybeTypeOnly,
        undefined,
      );
      node.specifiers.push(importSpecifier);
    }
  }

  // https://tc39.es/ecma262/#prod-ImportSpecifier
  parseImportSpecifier(
    specifier: Undone<N.ImportSpecifier>,
    importedIsString: boolean,
    /* used in TypeScript and Flow parser */
    isInTypeOnlyImport: boolean,
    isMaybeTypeOnly: boolean,
    bindingType: BindingFlag | undefined,
  ): N.ImportSpecifier {
    if (this.eatContextual(tt._as)) {
      specifier.local = this.parseIdentifier();
    } else {
      const { imported } = specifier;
      if (importedIsString) {
        throw this.raise(Errors.ImportBindingIsString, specifier, {
          importName: (imported as N.StringLiteral).value,
        });
      }
      this.checkReservedWord(
        (imported as N.Identifier).name,
        specifier.loc.start,
        true,
        true,
      );
      if (!specifier.local) {
        specifier.local = this.cloneIdentifier(imported as N.Identifier);
      }
    }
    return this.finishImportSpecifier(
      specifier,
      "ImportSpecifier",
      bindingType,
    );
  }

  // This is used in flow and typescript plugin
  // Determine whether a parameter is a this param
  isThisParam(
    param: N.Pattern | N.Identifier | N.TSParameterProperty,
  ): boolean {
    return param.type === "Identifier" && param.name === "this";
  }
}
