/**
 * Tokenizer State 状态管理文件
 *
 * 这个文件定义了 Babel 解析器中的核心状态类 State。
 * State 类负责跟踪和管理整个解析过程中的所有状态信息。
 *
 * ## 主要功能
 *
 * ### 1. Token 状态管理
 * - 当前 token 的类型、值、位置信息
 * - 上一个 token 的位置信息
 * - 解析器在源码中的当前位置
 *
 * ### 2. 解析上下文管理
 * - 严格模式状态
 * - JSX 元素解析状态
 * - 箭头函数参数检测
 * - 类型注解上下文
 *
 * ### 3. 错误处理和恢复
 * - 错误信息收集
 * - 严格模式错误的延迟处理
 * - 模板字符串中的非法转义序列
 *
 * ### 4. 位置信息跟踪
 * - 行号和列号跟踪
 * - 源码位置到行列的映射
 * - 为 source map 生成提供基础
 *
 * ### 5. 特殊语法支持
 * - Pipeline 操作符支持
 * - Topic 变量支持
 * - Flow/TypeScript 类型注解
 * - JSX 语法支持
 *
 * ## 设计特点
 *
 * ### 1. 状态克隆
 * - 支持完整的状态克隆，用于错误恢复和回溯解析
 * - 每个属性都会在 clone() 方法中被正确复制
 *
 * ### 2. 性能优化
 * - 使用 bit 装饰器进行状态压缩
 * - 将多个布尔状态打包在一个 flags 字段中
 *
 * ### 3. 可扩展性
 * - 支持各种语法插件的状态需求
 * - 为各种语言方言提供灵活的状态管理
 */

import type { Options } from "../options.ts";
import type { CommentWhitespace } from "../parser/comments";
import { Position } from "../util/location.ts";

import { types as ct, type TokContext } from "./context.ts";
import { tt, type TokenType } from "./types.ts";
import type { Errors } from "../parse-error.ts";
import type { ParseError } from "../parse-error.ts";

/**
 * 延迟处理的严格模式错误类型
 * 这些错误在解析时不会立即抛出，而是等到确定了严格模式状态后再决定是否报错
 * 
 */
export type DeferredStrictError =
  | typeof Errors.StrictNumericEscape // 严格模式下的数字转义错误
  | typeof Errors.StrictOctalLiteral; // 严格模式下的八进制字面量错误

/**
 * Topic 上下文状态类型
 * 用于 Hack 风格的 Pipeline 操作符支持
 * 支持将来的多个词法主题插件
 */
type TopicContextState = {
  // When a topic binding has been currently established,
  // then this is 1. Otherwise, it is 0. This is forwards compatible
  // with a future plugin for multiple lexical topics.
  // 当前已建立主题绑定时为 1，否则为 0。这与未来的多个词法主题插件向前兼容。
  maxNumOfResolvableTopics: number;
  // When a topic binding has been currently established, and if that binding
  // has been used as a topic reference `#`, then this is 0. Otherwise, it is
  // `null`. This is forwards compatible with a future plugin for multiple
  // lexical topics.
  // 当前已建立主题绑定，并且该绑定已被用作主题引用 `#` 时为 0，否则为 `null`。
  maxTopicIndex: null | 0;
};

/**
 * 循环标签类型枚举
 * 用于区分不同类型的标签语句
 */
export const enum LoopLabelKind {
  Loop = 1, // 循环标签（for、while 等）
  Switch = 2, // switch 语句标签
}

/**
 * Bit 装饰器声明
 * 用于将多个布尔属性打包到一个 flags 字段中，进行内存优化
 */
declare const bit: import("../../../../scripts/babel-plugin-bit-decorator/types.d.ts").BitDecorator<State>;

/**
 * State 类 - Babel 解析器的核心状态管理器
 *
 * 这个类包含了解析过程中所需的所有状态信息，包括：
 * - Token 信息（类型、值、位置）
 * - 解析上下文（严格模式、JSX、类型注解等）
 * - 错误处理和恢复状态
 * - 位置和源码映射信息
 * - 特殊语法特性的状态
 */
export default class State {
  /**
   * 位标志存储器
   * 使用 bit 装饰器将多个布尔状态打包在一个数字中以节省内存
   */
  @bit.storage flags: number;

  /**
   * 严格模式标志
   * 指示当前是否在严格模式下解析
   */
  @bit accessor strict = false;

  /**
   * 源码开始索引
   * 用于支持从非零位置开始解析
   */
  startIndex: number;

  /**
   * 当前行号
   * 从 1 开始计数
   */
  curLine: number;

  /**
   * 当前行的开始位置
   * 用于计算列号
   */
  lineStart: number;

  // And, if locations are used, the {line, column} object
  // corresponding to those offsets
  // 如果使用位置信息，则对应于这些偏移量的 {line, column} 对象

  /**
   * 解析开始位置
   */
  startLoc: Position;

  /**
   * 解析结束位置
   */
  endLoc: Position;

  init({
    strictMode,
    sourceType,
    startIndex,
    startLine,
    startColumn,
  }: Options): void {
    this.strict =
      strictMode === false
        ? false
        : strictMode === true
          ? true
          : sourceType === "module";

    this.startIndex = startIndex;
    this.curLine = startLine;
    this.lineStart = -startColumn;
    this.startLoc = this.endLoc = new Position(
      startLine,
      startColumn,
      startIndex,
    );
  }

  /**
   * 解析错误列表
   * 在错误恢复模式下收集所有遇到的解析错误
   */
  errors: ParseError<any>[] = [];

  // Used to signify the start of a potential arrow function
  // 用于标记潜在箭头函数的开始位置
  /**
   * 潜在箭头函数的开始位置
   * -1 表示当前没有潜在的箭头函数
   */
  potentialArrowAt: number = -1;

  // Used to signify the start of an expression which looks like a
  // typed arrow function, but it isn't
  // e.g. a ? (b) : c => d
  //          ^
  // 用于标记看起来像类型化箭头函数但实际不是的表达式开始位置
  /**
   * 非箭头函数位置列表
   * 记录那些看起来像箭头函数但实际不是的位置
   * 例如：a ? (b) : c => d 中的 (b)
   */
  noArrowAt: number[] = [];

  // Used to signify the start of an expression whose params, if it looks like
  // an arrow function, shouldn't be converted to assignable nodes.
  // This is used to defer the validation of typed arrow functions inside
  // conditional expressions.
  // e.g. a ? (b) : c => d
  //          ^
  // 用于标记一个表达式的开始位置，如果它看起来像箭头函数，
  // 其参数不应该被转换为可赋值节点。这用于延迟验证条件表达式内的类型化箭头函数。
  /**
   * 禁止箭头函数参数转换位置列表
   * 用于延迟验证条件表达式中的类型化箭头函数
   */
  noArrowParamsConversionAt: number[] = [];

  // Flags to track
  // 跟踪标志

  /**
   * 可能在箭头函数参数中
   * 用于解决箭头函数参数的语法模糊性
   */
  @bit accessor maybeInArrowParameters = false;

  /**
   * 在类型注解中
   * 指示当前是否在解析 TypeScript/Flow 类型注解
   */
  @bit accessor inType = false;

  /**
   * 禁止匿名函数类型
   * TypeScript 中的特定上下文标志
   */
  @bit accessor noAnonFunctionType = false;

  /**
   * 包含 Flow 注释
   * 指示源码中包含 Flow 类型注释
   */
  @bit accessor hasFlowComment = false;

  /**
   * 在环境上下文中
   * TypeScript 中的 ambient 声明上下文
   */
  @bit accessor isAmbientContext = false;

  /**
   * 在抽象类中
   * TypeScript 抽象类的解析上下文
   */
  @bit accessor inAbstractClass = false;

  /**
   * 在禁止条件类型上下文中
   * TypeScript 中的特定类型解析上下文
   */
  @bit accessor inDisallowConditionalTypesContext = false;

  // For the Hack-style pipelines plugin
  // 用于 Hack 风格的 Pipeline 插件
  /**
   * Topic 上下文状态
   * 支持 Hack 风格的 Pipeline 操作符中的 Topic 变量
   */
  topicContext: TopicContextState = {
    maxNumOfResolvableTopics: 0,
    maxTopicIndex: null,
  };

  // For the F#-style pipelines plugin
  // 用于 F# 风格的 Pipeline 插件

  /**
   * 单独的 await
   * F# 风格 Pipeline 中的 await 处理
   */
  @bit accessor soloAwait = false;

  /**
   * 在 F# Pipeline 直接体中
   * 指示当前是否在 F# 风格 Pipeline 的直接体中
   */
  @bit accessor inFSharpPipelineDirectBody = false;

  // Labels in scope.
  // 作用域内的标签
  /**
   * 当前作用域中的标签列表
   * 用于处理 break/continue 语句的标签引用
   */
  labels: Array<{
    kind: LoopLabelKind; // 标签类型（循环或 switch）
    name?: string | null; // 标签名称
    statementStart?: number; // 语句开始位置
  }> = [];

  /**
   * 注释数量
   * 用于跟踪已处理的注释数量
   */
  commentsLen = 0;

  // Comment attachment store
  // 注释附加存储
  /**
   * 注释堆栈
   * 存储待处理的注释信息，用于注释与 AST 节点的关联
   */
  commentStack: Array<CommentWhitespace> = [];

  // The current position of the tokenizer in the input.
  // 词法分析器在输入中的当前位置
  /**
   * 当前解析位置
   * 指示词法分析器在源码中的当前位置
   */
  pos: number = 0;

  // Properties of the current token:
  // 当前 token 的属性：
  // Its type
  // 其类型
  /**
   * 当前 token 的类型
   * 默认为 EOF（文件结束）
   */
  type: TokenType = tt.eof;

  // For tokens that include more information than their type, the value
  // 对于包含超出其类型信息的 token，其值
  /**
   * 当前 token 的值
   * 对于字面量 token（如数字、字符串），存储其实际值
   */
  value: any = null;

  // Its start and end offset
  // 其开始和结束偏移量
  /**
   * 当前 token 的开始位置
   */
  start: number = 0;

  /**
   * 当前 token 的结束位置
   */
  end: number = 0;

  // Position information for the previous token
  // 上一个 token 的位置信息
  // this is initialized when generating the second token.
  // 这在生成第二个 token 时初始化
  /**
   * 上一个 token 的结束位置
   * 用于 ASI（自动分号插入）和错误报告
   */
  lastTokEndLoc: Position = null;

  // this is initialized when generating the second token.
  // 这在生成第二个 token 时初始化
  /**
   * 上一个 token 的开始位置
   * 用于精确的位置跟踪
   */
  lastTokStartLoc: Position = null;

  // The context stack is used to track whether the apostrophe "`" starts
  // or ends a string template
  // 上下文堆栈用于跟踪撰号 "`" 是开始还是结束一个字符串模板
  /**
   * Token 上下文堆栈
   * 用于跟踪嵌套的语法结构（如模板字符串、JSX等）
   */
  context: Array<TokContext> = [ct.brace];

  // Used to track whether a JSX element is allowed to form
  // 用于跟踪是否允许形成 JSX 元素
  /**
   * 是否可以开始 JSX 元素
   * 用于避免在不适当的上下文中解析 JSX
   */
  @bit accessor canStartJSXElement = true;

  // Used to signal to callers of `readWord1` whether the word
  // contained any escape sequences. This is needed because words with
  // escape sequences must not be interpreted as keywords.
  // 用于向调用 `readWord1` 的程序发出信号，表明该单词是否
  // 包含任何转义序列。这是必要的，因为某些单词中存在此类序列。
  // 转义序列不得被解读为关键字。
  @bit accessor containsEsc = false;

  // Used to track invalid escape sequences in template literals,
  // that must be reported if the template is not tagged.
  // 用于跟踪模板字面量中的无效转义序列，
  // 如果模板没有被标记，必须报告这些错误
  /**
   * 第一个无效模板转义的位置
   * 用于延迟报告模板字符串中的转义错误
   */
  firstInvalidTemplateEscapePos: null | Position = null;

  /**
   * 包含顶级 await
   * 指示模块中是否使用了顶级 await
   */
  @bit accessor hasTopLevelAwait = false;

  // This property is used to track the following errors
  // - StrictNumericEscape
  // - StrictOctalLiteral
  //
  // in a literal that occurs prior to/immediately after a "use strict" directive.
  // 这个属性用于跟踪以下错误：
  // - StrictNumericEscape（严格模式数字转义）
  // - StrictOctalLiteral（严格模式八进制字面量）
  //
  // 在 "use strict" 指令之前/之后立即出现的字面量中。

  // todo(JLHwung): set strictErrors to null and avoid recording string errors
  // after a non-directive is parsed
  // 待办：在解析非指令后将 strictErrors 设置为 null 并避免记录字符串错误
  /**
   * 严格模式错误映射
   * 存储需要在确定严格模式后才能决定是否报告的错误
   */
  strictErrors: Map<number, [DeferredStrictError, Position]> = new Map();

  // Tokens length in token store
  // token 存储中的 token 数量
  /**
   * Token 存储中的 token 数量
   * 用于跟踪已生成的 token 数量
   */
  tokensLength: number = 0;

  /**
   * When we add a new property, we must manually update the `clone` method
   * 当我们添加新属性时，必须手动更新 `clone` 方法
   * @see State#clone
   */

  /**
   * 获取当前位置
   * 基于当前的 pos、curLine 和 lineStart 计算当前位置
   *
   * @returns 当前位置对象
   */
  curPosition(): Position {
    return new Position(
      this.curLine,
      this.pos - this.lineStart,
      this.pos + this.startIndex,
    );
  }

  /**
   * 克隆当前状态
   * 创建当前状态的深度副本，用于错误恢复和回溯解析
   *
   * 注意：每当添加新属性时，必须在此方法中添加相应的克隆逻辑
   *
   * @returns 克隆的状态对象
   */
  clone(): State {
    const state = new State();
    state.flags = this.flags;
    state.startIndex = this.startIndex;
    state.curLine = this.curLine;
    state.lineStart = this.lineStart;
    state.startLoc = this.startLoc;
    state.endLoc = this.endLoc;
    state.errors = this.errors.slice();
    state.potentialArrowAt = this.potentialArrowAt;
    state.noArrowAt = this.noArrowAt.slice();
    state.noArrowParamsConversionAt = this.noArrowParamsConversionAt.slice();
    state.topicContext = this.topicContext;
    state.labels = this.labels.slice();
    state.commentsLen = this.commentsLen;
    state.commentStack = this.commentStack.slice();
    state.pos = this.pos;
    state.type = this.type;
    state.value = this.value;
    state.start = this.start;
    state.end = this.end;
    state.lastTokEndLoc = this.lastTokEndLoc;
    state.lastTokStartLoc = this.lastTokStartLoc;
    state.context = this.context.slice();
    state.firstInvalidTemplateEscapePos = this.firstInvalidTemplateEscapePos;
    state.strictErrors = this.strictErrors;
    state.tokensLength = this.tokensLength;

    return state;
  }
}

/**
 * 前瞻状态类型
 *
 * 这是一个轻量级的状态对象，用于前瞻操作。
 * 相比完整的 State 对象，它只包含前瞻所需的关键信息，
 * 以提高性能。
 */
export type LookaheadState = {
  pos: number; // 当前位置
  value: any; // 当前 token 值
  type: TokenType; // 当前 token 类型
  start: number; // token 开始位置
  end: number; // token 结束位置
  context: TokContext[]; // 上下文堆栈副本
  startLoc: Position; // 开始位置
  lastTokEndLoc: Position; // 上一个 token 结束位置
  curLine: number; // 当前行号
  lineStart: number; // 当前行开始位置
  curPosition: State["curPosition"]; // 位置计算函数引用
  /* Used only in readToken_mult_modulo */
  /* 仅在 readToken_mult_modulo 中使用 */
  inType: boolean; // 是否在类型上下文中
  // These boolean properties are not initialized in createLookaheadState()
  // instead they will only be set by the tokenizer
  // 这些布尔属性不在 createLookaheadState() 中初始化，
  // 而是只由词法分析器设置
  containsEsc?: boolean; // 是否包含转义序列（可选）
};
