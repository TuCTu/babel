import type { Position } from "../util/location.ts";
import {
  tokenIsLiteralPropertyName,
  tt,
  type TokenType,
} from "../tokenizer/types.ts";
import Tokenizer from "../tokenizer/index.ts";
import type State from "../tokenizer/state.ts";
import type {
  EstreePropertyDefinition,
  Node,
  ObjectMethod,
  ObjectProperty,
  PrivateName,
} from "../types.d.ts";
import { hasNewLine } from "../util/whitespace.ts";
import { isIdentifierChar } from "../util/identifier.ts";
import ClassScopeHandler from "../util/class-scope.ts";
import ExpressionScopeHandler from "../util/expression-scope.ts";
import { ScopeFlag } from "../util/scopeflags.ts";
import ProductionParameterHandler, {
  ParamKind,
} from "../util/production-parameter.ts";
import {
  Errors,
  type ParseError,
  type ParseErrorConstructor,
} from "../parse-error.ts";
import type Parser from "./index.ts";

import type ScopeHandler from "../util/scope.ts";
import { OptionFlags } from "../options.ts";

/**
 * TryParse 结果类型，用于表示尝试解析操作的各种可能结果
 *
 * @template Node 解析成功时返回的节点类型
 * @template Error 解析失败时的错误类型
 * @template Thrown 是否抛出了异常
 * @template Aborted 是否被中止
 * @template FailState 失败时的解析器状态
 */
type TryParse<Node, Error, Thrown, Aborted, FailState> = {
  node: Node;
  error: Error;
  thrown: Thrown;
  aborted: Aborted;
  failState: FailState;
};

/**
 * UtilParser 类是 Babel 解析器中的核心实用工具类，继承自 Tokenizer。
 * 它提供了解析过程中所需的各种辅助方法和状态管理功能。
 *
 * ## 主要职责
 *
 * ### 1. Token 处理与上下文关键字管理
 * - 识别和处理上下文关键字（如 async、await、get、set 等）
 * - 提供 token 匹配、消费、期望等核心操作
 * - 处理字面量属性名和私有字段名
 *
 * ### 2. 语法规则处理
 * - 自动分号插入（ASI）逻辑
 * - 分号处理和行终止符检测
 * - 换行符检测和位置跟踪
 *
 * ### 3. 错误处理与恢复
 * - 表达式错误收集和验证
 * - 解析错误的抛出和处理
 * - tryParse 机制用于回溯和错误恢复
 *
 * ### 4. 作用域管理
 * - 初始化和管理各种作用域处理器
 * - 类作用域、表达式作用域、生产参数作用域
 * - 模块和脚本上下文的处理
 *
 * ### 5. AST 节点辅助功能
 * - 节点额外属性管理
 * - 私有名称处理
 * - 对象属性和方法类型判断
 *
 * ## 在解析流程中的作用
 *
 * UtilParser 作为解析器的基础层，为上层的语句解析器（StatementParser）
 * 和表达式解析器（ExpressionParser）提供了必要的工具方法。它处理了
 * 大量的底层细节，使得上层解析逻辑能够专注于语法结构的构建。
 *
 * ## Parser utilities
 */
export default abstract class UtilParser extends Tokenizer {
  // Forward-declaration: defined in parser/index.js
  abstract getScopeHandler(): new (...args: any) => ScopeHandler;

  /**
   * Add extra properties to AST nodes
   * 为 AST 节点添加额外属性
   *
   * 这个方法用于向 AST 节点添加不属于标准 AST 规范但对工具有用的额外信息，
   * 例如：原始源码文本、注释信息、格式化提示等
   *
   * @param node AST 节点
   * @param key 属性键名
   * @param value 属性值
   * @param enumerable 是否可枚举，默认为 true
   */
  addExtra(
    node: Partial<Node>,
    key: string,
    value: any,
    enumerable: boolean = true,
  ): void {
    if (!node) return;

    let { extra } = node;
    if (extra == null) {
      extra = {};
      node.extra = extra;
    }

    if (enumerable) {
      extra[key] = value;
    } else {
      Object.defineProperty(extra, key, { enumerable, value });
    }
  }

  // Tests whether parsed token is a contextual keyword.
  // 测试解析的标记是否是上下文关键字。
  isContextual(token: TokenType): boolean {
    return this.state.type === token && !this.state.containsEsc;
  }

  /**
   * Check if the given name at the given position is a contextual keyword
   * without parsing it as a token
   * 检查给定位置的名称是否为上下文关键字，而不将其解析为 token
   *
   * 这个方法用于前瞻检查，在不改变解析器状态的情况下判断某个位置
   * 是否包含特定的上下文关键字
   *
   * @param nameStart 名称开始位置
   * @param name 要检查的名称
   * @returns 是否为上下文关键字
   */
  isUnparsedContextual(nameStart: number, name: string): boolean {
    if (this.input.startsWith(name, nameStart)) {
      const nextCh = this.input.charCodeAt(nameStart + name.length);
      return !(
        isIdentifierChar(nextCh) ||
        // check if `nextCh is between 0xd800 - 0xdbff,
        // if `nextCh` is NaN, `NaN & 0xfc00` is 0, the function
        // returns true
        (nextCh & 0xfc00) === 0xd800
      );
    }
    return false;
  }

  /**
   * Check if the next token is a contextual keyword with the given name
   * 检查下一个 token 是否为给定名称的上下文关键字
   *
   * 这是一个前瞻方法，用于在不消费 token 的情况下检查下一个 token
   *
   * @param name 要检查的关键字名称
   * @returns 下一个 token 是否为指定的上下文关键字
   */
  isLookaheadContextual(name: string): boolean {
    const next = this.nextTokenStart();
    return this.isUnparsedContextual(next, name);
  }

  // Consumes contextual keyword if possible.

  // 如果可能的话，使用上下文关键字。
  eatContextual(token: TokenType): boolean {
    if (this.isContextual(token)) {
      this.next();
      return true;
    }
    return false;
  }

  // Asserts that following token is given contextual keyword.

  // 断言以下标记被赋予了上下文关键字。
  expectContextual(
    token: TokenType,
    toParseError?: ParseErrorConstructor<any>,
  ): void {
    if (!this.eatContextual(token)) {
      if (toParseError != null) {
        throw this.raise(toParseError, this.state.startLoc);
      }
      this.unexpected(null, token);
    }
  }

  // Test whether a semicolon can be inserted at the current position.
  // 测试是否可以在当前位置插入分号。
  canInsertSemicolon(): boolean {
    return (
      this.match(tt.eof) ||
      this.match(tt.braceR) ||
      this.hasPrecedingLineBreak()
    );
  }

  /**
   * Check if there is a line break before the current token
   * 检查当前 token 之前是否有换行符
   *
   * 这个方法对于自动分号插入（ASI）规则很重要
   *
   * @returns 是否存在前置换行符
   */
  hasPrecedingLineBreak(): boolean {
    return hasNewLine(
      this.input,
      this.offsetToSourcePos(this.state.lastTokEndLoc.index),
      this.state.start,
    );
  }

  /**
   * Check if there is a line break after the current token
   * 检查当前 token 之后是否有换行符
   *
   * @returns 是否存在后置换行符
   */
  hasFollowingLineBreak(): boolean {
    return hasNewLine(this.input, this.state.end, this.nextTokenStart());
  }

  /**
   * Check if current position is a line terminator (semicolon or ASI position)
   * 检查当前位置是否为行终止符（分号或 ASI 位置）
   *
   * 根据 ECMAScript 规范，行终止符可以是：
   * - 显式的分号
   * - 可以插入分号的位置（ASI 规则）
   *
   * @returns 是否为行终止符
   */
  isLineTerminator(): boolean {
    return this.eat(tt.semi) || this.canInsertSemicolon();
  }

  // Consume a semicolon, or, failing that, see if we are allowed to
  // pretend that there is a semicolon at this position.

  // 消耗一个分号，或者，如果失败了，看看我们是否被允许
  // 假装这个位置有一个分号。

  semicolon(allowAsi: boolean = true): void {
    if (allowAsi ? this.isLineTerminator() : this.eat(tt.semi)) return;
    this.raise(Errors.MissingSemicolon, this.state.lastTokEndLoc);
  }

  // Expect a token of a given type. If found, consume it, otherwise,
  // raise an unexpected token error at given pos.

  // 期望一个指定类型的令牌。如果找到，则使用它，否则，
  // 在指定位置引发意外的令牌错误。

  expect(type: TokenType, loc?: Position | null): void {
    if (!this.eat(type)) {
      this.unexpected(loc, type);
    }
  }

  // tryParse will clone parser state.
  // It is expensive and should be used with cautions
  // tryParse 将克隆解析器状态。
  // 它开销很大，应谨慎使用
  tryParse<T extends Node | ReadonlyArray<Node>>(
    fn: (abort: (node?: T) => never) => T,
    oldState: State = this.state.clone(),
  ):
    | TryParse<T, null, false, false, null>
    | TryParse<T | null, ParseError<any>, boolean, false, State>
    | TryParse<T | null, null, false, true, State> {
    const abortSignal: {
      node: T | null;
    } = { node: null };
    try {
      const node = fn((node = null) => {
        abortSignal.node = node;
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw abortSignal;
      });
      if (this.state.errors.length > oldState.errors.length) {
        const failState = this.state;
        this.state = oldState;
        // tokensLength should be preserved during error recovery mode
        // since the parser does not halt and will instead parse the
        // remaining tokens
        // 在错误恢复模式下，tokens Length 应该被保留
        // 因为解析器不会停止，而是会解析
        // 剩余的 tokens
        this.state.tokensLength = failState.tokensLength;
        return {
          node,
          error: failState.errors[oldState.errors.length],
          thrown: false,
          aborted: false,
          failState,
        };
      }

      return {
        node,
        error: null,
        thrown: false,
        aborted: false,
        failState: null,
      };
    } catch (error) {
      const failState = this.state;
      this.state = oldState;
      if (error instanceof SyntaxError) {
        // @ts-expect-error casting general syntax error to parse error
        return { node: null, error, thrown: true, aborted: false, failState };
      }
      if (error === abortSignal) {
        return {
          node: abortSignal.node,
          error: null,
          thrown: false,
          aborted: true,
          failState,
        };
      }

      throw error;
    }
  }

  /**
   * Check and optionally throw expression errors that were collected during parsing
   * 检查并可选择性地抛出解析过程中收集的表达式错误
   *
   * 在解析表达式时，某些语法在不同上下文中可能有不同的含义。
   * 这个方法用于在确定上下文后检查是否存在语法错误。
   *
   * @param refExpressionErrors 表达式错误引用
   * @param andThrow 是否抛出错误，如果为 false 则只返回是否有错误
   * @returns 如果 andThrow 为 false，返回是否存在错误
   */
  checkExpressionErrors(
    refExpressionErrors: ExpressionErrors | undefined | null,
    andThrow: boolean,
  ) {
    if (!refExpressionErrors) return false;
    const {
      shorthandAssignLoc,
      doubleProtoLoc,
      privateKeyLoc,
      optionalParametersLoc,
      voidPatternLoc,
    } = refExpressionErrors;

    const hasErrors =
      !!shorthandAssignLoc ||
      !!doubleProtoLoc ||
      !!optionalParametersLoc ||
      !!privateKeyLoc ||
      !!voidPatternLoc;

    if (!andThrow) {
      return hasErrors;
    }

    if (shorthandAssignLoc != null) {
      this.raise(Errors.InvalidCoverInitializedName, shorthandAssignLoc);
    }

    if (doubleProtoLoc != null) {
      this.raise(Errors.DuplicateProto, doubleProtoLoc);
    }

    if (privateKeyLoc != null) {
      this.raise(Errors.UnexpectedPrivateField, privateKeyLoc);
    }

    if (optionalParametersLoc != null) {
      this.unexpected(optionalParametersLoc);
    }

    if (voidPatternLoc != null) {
      this.raise(Errors.InvalidCoverDiscardElement, voidPatternLoc);
    }
  }

  /**
   * 判断当前的 token 是否为“字面量属性名”。
   * Test if current token is a literal property name
   * 参考 ECMAScript 规范：https://tc39.es/ecma262/#prod-LiteralPropertyName
   * LiteralPropertyName（字面量属性名）包括以下几种形式：
   *   - IdentifierName（标识符名称 / IdentifierName）
   *   - StringLiteral（字符串字面量 / StringLiteral）
   *   - NumericLiteral（数字字面量 / NumericLiteral）
   *   - BigIntLiteral（大整数字面量 / BigIntLiteral）
   * 也就是说，如果当前 token 是上述任意一种类型，则它可以作为对象字面量的属性名。
   */
  isLiteralPropertyName(): boolean {
    return tokenIsLiteralPropertyName(this.state.type);
  }

  /**
   * Test if given node is a PrivateName
   * will be overridden in ESTree plugin
   * 测试给定节点是否为 PrivateName
   * 将在 ESTree 插件中被覆盖
   */
  isPrivateName(node: Node): node is PrivateName {
    return node.type === "PrivateName";
  }

  /**
   * Return the string value of a given private name
   * WITHOUT `#`
   * 返回给定私有名称的字符串值
   * 不带 `#`
   * @see {@link https://tc39.es/ecma262/#sec-static-semantics-stringvalue}
   */
  getPrivateNameSV(node: PrivateName): string {
    return node.id.name;
  }

  /**
   * Return whether the given node is a member/optional chain that
   * contains a private name as its property
   * It is overridden in ESTree plugin
   * 返回给定节点是否为成员/可选链
   * 包含私有名称作为其属性
   * 已在 ESTree 插件中覆盖
   */
  hasPropertyAsPrivateName(node: Node): boolean {
    return (
      (node.type === "MemberExpression" ||
        node.type === "OptionalMemberExpression") &&
      this.isPrivateName(node.property)
    );
  }

  /**
   * Type guard to check if a node is an ObjectProperty
   * 类型守卫，检查节点是否为 ObjectProperty
   *
   * @param node 要检查的 AST 节点
   * @returns 是否为对象属性节点
   */
  isObjectProperty(
    node: Node,
  ): node is ObjectProperty | EstreePropertyDefinition {
    return node.type === "ObjectProperty";
  }

  /**
   * Type guard to check if a node is an ObjectMethod
   * 类型守卫，检查节点是否为 ObjectMethod
   *
   * @param node 要检查的 AST 节点
   * @returns 是否为对象方法节点
   */
  isObjectMethod(node: Node): node is ObjectMethod {
    return node.type === "ObjectMethod";
  }

  /**
   * Initialize all scope handlers and state for parsing
   * 初始化解析所需的所有作用域处理器和状态
   *
   * 这个方法设置解析器的初始状态，包括：
   * - 标签作用域
   * - 导出标识符集合
   * - 模块/脚本上下文
   * - 各种作用域处理器（变量、类、表达式、生产参数）
   *
   * @param inModule 是否在模块上下文中
   * @returns 清理函数，用于恢复之前的状态
   */
  initializeScopes(
    this: Parser,
    inModule: boolean = this.options.sourceType === "module",
  ): () => void {
    // Initialize state
    const oldLabels = this.state.labels;
    this.state.labels = [];

    const oldExportedIdentifiers = this.exportedIdentifiers;
    this.exportedIdentifiers = new Set();

    // initialize scopes
    const oldInModule = this.inModule;
    this.inModule = inModule;

    const oldScope = this.scope;
    const ScopeHandler = this.getScopeHandler();
    this.scope = new ScopeHandler(this, inModule);

    const oldProdParam = this.prodParam;
    this.prodParam = new ProductionParameterHandler();

    const oldClassScope = this.classScope;
    this.classScope = new ClassScopeHandler(this);

    const oldExpressionScope = this.expressionScope;
    this.expressionScope = new ExpressionScopeHandler(this);

    return () => {
      // Revert state
      this.state.labels = oldLabels;
      this.exportedIdentifiers = oldExportedIdentifiers;

      // Revert scopes
      this.inModule = oldInModule;
      this.scope = oldScope;
      this.prodParam = oldProdParam;
      this.classScope = oldClassScope;
      this.expressionScope = oldExpressionScope;
    };
  }

  /**
   * Enter the initial scopes based on parsing options
   * 根据解析选项进入初始作用域
   *
   * 这个方法根据解析选项设置初始的参数标志和作用域标志：
   * - 模块环境下允许 await
   * - 根据选项允许 yield、return、new.target
   * - 区分 CommonJS 和 ES 模块环境
   */
  enterInitialScopes() {
    let paramFlags = ParamKind.PARAM;
    if (
      this.inModule ||
      this.optionFlags & OptionFlags.AllowAwaitOutsideFunction
    ) {
      paramFlags |= ParamKind.PARAM_AWAIT;
    }
    if (this.optionFlags & OptionFlags.AllowYieldOutsideFunction) {
      paramFlags |= ParamKind.PARAM_YIELD;
    }
    // The inModule flag ensures that the module block within a CommonJS source
    // will be treated as an ES module.
    const isCommonJS = !this.inModule && this.options.sourceType === "commonjs";
    if (
      isCommonJS ||
      this.optionFlags & OptionFlags.AllowReturnOutsideFunction
    ) {
      paramFlags |= ParamKind.PARAM_RETURN;
    }
    this.prodParam.enter(paramFlags);
    let scopeFlags = isCommonJS ? ScopeFlag.FUNCTION : ScopeFlag.PROGRAM;
    if (this.optionFlags & OptionFlags.AllowNewTargetOutsideFunction) {
      scopeFlags |= ScopeFlag.NEW_TARGET;
    }
    this.scope.enter(scopeFlags);
  }

  /**
   * Check if destructuring private fields is used and ensure the plugin is enabled
   * 检查是否使用了私有字段解构，并确保启用了相应插件
   *
   * @param refExpressionErrors 表达式错误引用，包含私有字段位置信息
   */
  checkDestructuringPrivate(refExpressionErrors: ExpressionErrors) {
    const { privateKeyLoc } = refExpressionErrors;
    if (privateKeyLoc !== null) {
      this.expectPlugin("destructuringPrivate", privateKeyLoc);
    }
  }
}

/**
 * ExpressionErrors 是一个上下文结构体，用于跟踪模糊的语法模式。
 * 当我们确定解析的模式是右侧表达式（RHS），意味着它不是一个模式时，
 * 我们会在无效赋值语法的位置抛出错误，否则它将被重置为 null。
 *
 * The ExpressionErrors is a context struct used to track ambiguous patterns.
 * When we are sure the parsed pattern is a RHS, which means it is not a pattern,
 * we will throw on this position on invalid assign syntax, otherwise it will be reset to null.
 *
 * ## 错误类型 / Types of ExpressionErrors:
 *
 * - **shorthandAssignLoc**: 跟踪初始化器 `=` 的位置 / track initializer `=` position
 *   例如：`{a = 1}` 在对象字面量中是无效的
 *
 * - **doubleProtoLoc**: 跟踪重复的 `__proto__` 键位置 / track the duplicate `__proto__` key position
 *   例如：`{__proto__: a, __proto__: b}` 是无效的
 *
 * - **privateKeyLoc**: 跟踪私有键 `#p` 位置 / track private key `#p` position
 *   例如：`{#private: value}` 在某些上下文中是无效的
 *
 * - **optionalParametersLoc**: 跟踪可选参数 (`?`) 的位置 / track the optional parameter (`?`).
 *   仅用于 TypeScript 和 Flow 插件 / It's only used by typescript and flow plugins
 *
 * - **voidPatternLoc**: 跟踪 void 模式位置 / track void pattern position
 *   用于处理丢弃元素的情况
 *
 * ## 使用场景
 *
 * 这个类主要用于处理 JavaScript 中语法上模糊的情况，例如：
 * - `{a}` 可能是对象字面量或解构模式
 * - `(a, b)` 可能是分组表达式或箭头函数参数
 * - `[a, b]` 可能是数组字面量或解构模式
 *
 * 通过收集这些潜在的错误位置，解析器可以在后续确定语法含义时
 * 决定是否抛出相应的语法错误。
 */
export class ExpressionErrors {
  shorthandAssignLoc: Position | undefined | null = null;
  doubleProtoLoc: Position | undefined | null = null;
  privateKeyLoc: Position | undefined | null = null;
  optionalParametersLoc: Position | undefined | null = null;
  voidPatternLoc: Position | undefined | null = null;
}
