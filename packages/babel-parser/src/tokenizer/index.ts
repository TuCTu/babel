/*:: declare var invariant; */

import { OptionFlags, type Options } from "../options.ts";
import {
  Position,
  SourceLocation,
  createPositionWithColumnOffset,
} from "../util/location.ts";
import CommentsParser, { type CommentWhitespace } from "../parser/comments.ts";
import type * as N from "../types.ts";
import * as charCodes from "charcodes";
import { isIdentifierStart, isIdentifierChar } from "../util/identifier.ts";
import {
  tokenIsKeyword,
  tokenLabelName,
  tt,
  keywords as keywordTypes,
  type TokenType,
} from "./types.ts";
import type { TokContext } from "./context.ts";
import {
  Errors,
  type ParseError,
  type ParseErrorConstructor,
} from "../parse-error.ts";
import {
  lineBreakG,
  isNewLine,
  isWhitespace,
  skipWhiteSpace,
  skipWhiteSpaceInLine,
} from "../util/whitespace.ts";
import State from "./state.ts";
import type { LookaheadState, DeferredStrictError } from "./state.ts";
import type { Undone } from "../parser/node.ts";
import type { Node } from "../types.ts";

import {
  readInt,
  readCodePoint,
  readStringContents,
  type IntErrorHandlers,
  type CodePointErrorHandlers,
  type StringContentsErrorHandlers,
} from "@babel/helper-string-parser";

import type { Plugin } from "../typings.ts";

function buildPosition(pos: number, lineStart: number, curLine: number) {
  return new Position(curLine, pos - lineStart, pos);
}

const VALID_REGEX_FLAGS = new Set([
  charCodes.lowercaseG,
  charCodes.lowercaseM,
  charCodes.lowercaseS,
  charCodes.lowercaseI,
  charCodes.lowercaseY,
  charCodes.lowercaseU,
  charCodes.lowercaseD,
  charCodes.lowercaseV,
]);

// Object type used to represent tokens. Note that normally, tokens
// simply exist as properties on the parser object. This is only
// used for the onToken callback and the external tokenizer.
// 用于表示标记的对象类型。注意，通常情况下，标记
// 仅作为解析器对象的属性存在。这仅
// 用于 onToken 回调和外部标记器。

export class Token {
  constructor(state: State) {
    const startIndex = state.startIndex || 0;
    this.type = state.type;
    this.value = state.value;
    this.start = startIndex + state.start;
    this.end = startIndex + state.end;
    this.loc = new SourceLocation(state.startLoc, state.endLoc);
  }

  declare type: TokenType;
  declare value: any;
  declare start: number;
  declare end: number;
  declare loc: SourceLocation;
}

// ## Tokenizer

/**
 * Tokenizer 类是 Babel 解析器中的核心词法分析器，继承自 CommentsParser。
 * 主要作用是将JavaScript/TypeScript源代码字符串转换为一系列结构化的 Token（标记），
 * 为后续的语法分析（Parser）提供基础数据。
 *
 * ## 核心功能
 *
 * ### 1. 词法分析（Lexical Analysis）
 * 将源代码字符流转换为有意义的 Token 序列
 *
 * ### 2. Token 类型识别与分类
 * 识别并分类各种语言元素：
 * - 标识符和关键字：变量名、函数名、if、for、const等
 * - 字面量：数字、字符串、模板字符串、正则表达式、BigInt
 * - 操作符：算术、逻辑、比较、赋值操作符
 * - 分隔符：括号、花括号、方括号、逗号、分号等
 * - 特殊Token：EOF、JSX相关、装饰器、私有字段等
 *
 * ### 3. 高级语言特性支持
 * 处理现代JavaScript/TypeScript的复杂语法：
 * - 模板字符串
 * - BigInt 数字字面量
 * - 私有字段标识符
 * - 可选链操作符
 * - 管道操作符等
 *
 * ### 4. 注释与空白处理
 * 继承自 CommentsParser，能够：
 * - 跳过空白字符：空格、制表符、换行符
 * - 处理注释：单行注释、多行注释
 * - 保留注释信息：将注释关联到相应的AST节点
 * - 处理特殊注释：HTML风格注释、shebang等
 *
 * ### 5. 位置追踪与错误处理
 * 精确追踪每个Token在源码中的位置：
 * - 行号和列号：记录每个Token的确切位置
 * - 源码偏移：记录字符在源码中的绝对位置
 * - 错误恢复：遇到语法错误时能够继续解析
 * - 错误定位：提供准确的错误位置信息
 *
 * ### 6. Lookahead 机制
 * 提供预见功能，不修改当前状态的情况下查看下一个Token
 *
 * ### 7. 上下文感知解析
 * 根据不同语法上下文调整Token解析行为：
 * - JSX上下文：识别JSX标签和属性
 * - 模板上下文：处理模板字符串内的表达式
 * - 正则表达式上下文：区分除号和正则表达式
 * - 类型注解上下文：TypeScript类型解析
 *
 * ## 解析流程
 *
 * 1. 字符读取：从源码中逐字符读取
 * 2. 模式匹配：根据当前字符确定Token类型
 * 3. 状态追踪：维护解析状态（位置、上下文等）
 * 4. Token生成：创建包含类型、值、位置信息的Token
 * 5. 注释处理：识别并正确关联注释
 * 6. 错误检测：发现并报告词法错误
 *
 * ## 在Babel生态中的作用
 *
 * 作为源码到AST转换流程的第一步：
 * - 语法分析基础：为Parser提供结构化的Token序列
 * - 工具支持：为IDE、格式化工具、语法高亮等提供词法信息
 * - 插件系统：支持各种JavaScript提案和方言的扩展解析
 * - 性能优化：通过高效的字符处理和状态管理确保解析速度
 *
 * 核心价值：将非结构化的文本源码转换为结构化的Token流，
 * 是所有后续语法分析、代码转换和静态分析的基础。
 */
export default abstract class Tokenizer extends CommentsParser {
  isLookahead: boolean;

  // Token store.
  tokens: Array<Token | N.Comment> = [];

  /**
   * Tokenizer 构造函数
   * 初始化词法分析器的状态和输入源码
   *
   * @param options 解析选项配置
   * @param input 要解析的源代码字符串
   */
  constructor(options: Options, input: string) {
    super();
    this.state = new State();
    this.state.init(options);
    this.input = input;
    this.length = input.length;
    this.comments = [];
    this.isLookahead = false;
  }

  /**
   * 将 token 推入 tokens 数组
   * 在插件的 try-catch 解析过程中，可能会产生无效的 token，此方法会清理这些无效 token
   *
   * @param token 要推入的 token 或注释对象
   */
  pushToken(token: Token | N.Comment) {
    // Pop out invalid tokens trapped by try-catch parsing.
    // Those parsing branches are mainly created by typescript and flow plugins.
    // 弹出由 try-catch 解析捕获的无效标记。
    // 那些解析分支主要是由 TypeScript 和 Flow 插件创建的。
    this.tokens.length = this.state.tokensLength;
    this.tokens.push(token);
    ++this.state.tokensLength;
  }

  /**
   * 移动到下一个 token
   * 完成当前 token 的处理并准备解析下一个 token
   */
  next(): void {
    this.checkKeywordEscapes();
    if (this.optionFlags & OptionFlags.Tokens) {
      this.pushToken(new Token(this.state));
    }

    this.state.lastTokEndLoc = this.state.endLoc;
    this.state.lastTokStartLoc = this.state.startLoc;
    this.nextToken();
  }

  /**
   * 尝试"消费"指定类型的 token
   * 如果当前 token 匹配指定类型，则移动到下一个 token 并返回 true
   * 否则不做任何操作并返回 false
   *
   * @param type 期望的 token 类型
   * @returns 是否成功消费了指定类型的 token
   */
  eat(type: TokenType): boolean {
    if (this.match(type)) {
      this.next();
      return true;
    } else {
      return false;
    }
  }

  /**
   * Whether current token matches given type
   * 当前令牌是否匹配给定类型
   */
  match(type: TokenType): boolean {
    return this.state.type === type;
  }

  /**
   * Create a LookaheadState from current parser state
   * 从当前解析器状态创建 LookaheadState
   */
  createLookaheadState(state: State): LookaheadState {
    return {
      pos: state.pos,
      value: null,
      type: state.type,
      start: state.start,
      end: state.end,
      context: [this.curContext()],
      inType: state.inType,
      startLoc: state.startLoc,
      lastTokEndLoc: state.lastTokEndLoc,
      curLine: state.curLine,
      lineStart: state.lineStart,
      curPosition: state.curPosition,
    };
  }

  /**
   * lookahead peeks the next token, skipping changes to token context and
   * comment stack. For performance it returns a limited LookaheadState
   * instead of full parser state.
   *
   * The { column, line } Loc info is not included in lookahead since such usage
   * is rare. Although it may return other location properties e.g. `curLine` and
   * `lineStart`, these properties are not listed in the LookaheadState interface
   * and thus the returned value is _NOT_ reliable.
   *
   * The tokenizer should make best efforts to avoid using any parser state
   * other than those defined in LookaheadState
   *
   * lookahead 会查看下一个 token，跳过 token 上下文和注释堆栈的更改。为了提高性能，它返回一个受限的 LookaheadState，而不是完整的解析器状态。
   *
   * lookahead 中不包含 { column, line } 位置信息，因为这种用法
   * 很少见。虽然它可能返回其他位置属性，例如 `curLine` 和
   * `lineStart`，但这些属性未在 LookaheadState 接口中列出，
   * 因此返回值不可靠。
   *
   * 标记器应尽力避免使用除 LookaheadState 中定义的解析器状态之外的任何解析器状态。
   *
   */
  lookahead(): LookaheadState {
    const old = this.state;
    // @ts-expect-error For performance we use a simplified tokenizer state structure
    this.state = this.createLookaheadState(old);

    this.isLookahead = true;
    this.nextToken();
    this.isLookahead = false;

    const curr = this.state;
    this.state = old;
    return curr;
  }

  /**
   * 获取下一个 token 的开始位置（跳过空白字符）
   * @returns 下一个 token 的开始位置
   */
  nextTokenStart(): number {
    return this.nextTokenStartSince(this.state.pos);
  }

  /**
   * 从指定位置开始，获取下一个 token 的开始位置（跳过空白字符）
   * @param pos 开始搜索的位置
   * @returns 下一个 token 的开始位置
   */
  nextTokenStartSince(pos: number): number {
    skipWhiteSpace.lastIndex = pos;
    return skipWhiteSpace.test(this.input) ? skipWhiteSpace.lastIndex : pos;
  }

  /**
   * 前瞻下一个非空白字符的字符代码
   * @returns 下一个非空白字符的字符代码
   */
  lookaheadCharCode(): number {
    return this.lookaheadCharCodeSince(this.state.pos);
  }

  /**
   * 从指定位置开始，前瞻下一个非空白字符的字符代码
   * @param pos 开始搜索的位置
   * @returns 下一个非空白字符的字符代码
   */
  lookaheadCharCodeSince(pos: number): number {
    return this.input.charCodeAt(this.nextTokenStartSince(pos));
  }

  /**
   * Similar to nextToken, but it will stop at line break when it is seen before the next token
   *
   * @returns {number} position of the next token start or line break, whichever is seen first.
   * @memberof Tokenizer
   * 获取行内下一个 token 的开始位置
   * 类似于 nextToken，但遇到换行符时会停止
   *
   * @returns 下一个 token 开始位置或换行符位置，以先遇到的为准
   */
  nextTokenInLineStart(): number {
    return this.nextTokenInLineStartSince(this.state.pos);
  }

  /**
   * 从指定位置开始，获取行内下一个 token 的开始位置
   * @param pos 开始搜索的位置
   * @returns 下一个 token 开始位置或换行符位置，以先遇到的为准
   */
  nextTokenInLineStartSince(pos: number): number {
    skipWhiteSpaceInLine.lastIndex = pos;
    return skipWhiteSpaceInLine.test(this.input)
      ? skipWhiteSpaceInLine.lastIndex
      : pos;
  }

  /**
   * Similar to lookaheadCharCode, but it will return the char code of line break if it is
   * seen before the next token
   *
   * @returns {number} char code of the next token start or line break, whichever is seen first.
   * @memberof Tokenizer
   * 前瞻行内字符代码
   * 类似于 lookaheadCharCode，但如果在下一个 token 之前遇到换行符，会返回换行符的字符代码
   *
   * @returns 下一个 token 开始处或换行符的字符代码，以先遇到的为准
   */
  lookaheadInLineCharCode(): number {
    return this.input.charCodeAt(this.nextTokenInLineStart());
  }

  /**
   * 获取指定位置的 Unicode 码点
   * 正确处理 Unicode 代理对（surrogate pairs），支持超出基本多文种平面的字符
   *
   * 实现基于 V8 源码，为了性能优化而重新实现
   * 因为大部分输入都是 ASCII 字符，内联的 charCodeAt 性能更好
   *
   * @param pos 字符位置
   * @returns Unicode 码点值
   */
  codePointAtPos(pos: number): number {
    // The implementation is based on
    // https://source.chromium.org/chromium/chromium/src/+/master:v8/src/builtins/builtins-string-gen.cc;l=1455;drc=221e331b49dfefadbc6fa40b0c68e6f97606d0b3;bpv=0;bpt=1
    // We reimplement `codePointAt` because `codePointAt` is a V8 builtin which is not inlined by TurboFan (as of M91)
    // since `input` is mostly ASCII, an inlined `charCodeAt` wins here
    let cp = this.input.charCodeAt(pos);
    if ((cp & 0xfc00) === 0xd800 && ++pos < this.input.length) {
      const trail = this.input.charCodeAt(pos);
      if ((trail & 0xfc00) === 0xdc00) {
        cp = 0x10000 + ((cp & 0x3ff) << 10) + (trail & 0x3ff);
      }
    }
    return cp;
  }

  // Toggle strict mode. Re-reads the next number or string to please
  // pedantic tests (`"use strict"; 010;` should fail).

  /**
   * 切换严格模式
   * 重新读取下一个数字或字符串以满足严格的测试要求
   * （例如在严格模式下 `"use strict"; 010;` 应该失败）
   *
   * @param strict 是否启用严格模式
   */
  setStrict(strict: boolean): void {
    this.state.strict = strict;
    if (strict) {
      // Throw an error for any string decimal escape found before/immediately
      // after a "use strict" directive. Strict mode will be set at parse
      // time for any literals that occur after the next node of the strict
      // directive.
      this.state.strictErrors.forEach(([toParseError, at]) =>
        this.raise(toParseError, at),
      );
      this.state.strictErrors.clear();
    }
  }

  /**
   * 获取当前的 token 上下文
   * token 上下文用于处理不同语法环境下的 token 解析规则
   *
   * @returns 当前的 token 上下文
   */
  curContext(): TokContext {
    return this.state.context[this.state.context.length - 1];
  }

  /**
   * Read a single token, updating the parser object's token-related properties.
   * 读取单个 token，更新解析器对象的 token 相关属性
   * 这是词法分析的核心方法，负责从字符流中识别和创建 token
   */
  nextToken(): void {
    this.skipSpace();
    this.state.start = this.state.pos;
    if (!this.isLookahead) this.state.startLoc = this.state.curPosition();
    if (this.state.pos >= this.length) {
      this.finishToken(tt.eof);
      return;
    }

    this.getTokenFromCode(this.codePointAtPos(this.state.pos));
  }

  // Skips a block comment, whose end is marked by commentEnd.
  // *-/ is used by the Flow plugin, when parsing block comments nested
  // inside Flow comments.

  /**
   * 跳过块注释，块注释的结束由 commentEnd 标记
   * "star-slash" 用于 Flow 插件，当解析嵌套在 Flow 注释内的块注释时使用
   *
   * @param commentEnd 注释结束标记，可以是 "star-slash" 或 "star-dash-slash"
   * @returns 如果不是前瞻模式，返回注释对象，否则返回 undefined
   */
  skipBlockComment(commentEnd: "*/" | "*-/"): N.CommentBlock | undefined {
    let startLoc;
    if (!this.isLookahead) startLoc = this.state.curPosition();
    const start = this.state.pos;
    const end = this.input.indexOf(commentEnd, start + 2);
    if (end === -1) {
      // We have to call this again here because startLoc may not be set...
      // This seems to be for performance reasons:
      // https://github.com/babel/babel/commit/acf2a10899f696a8aaf34df78bf9725b5ea7f2da
      throw this.raise(Errors.UnterminatedComment, this.state.curPosition());
    }

    this.state.pos = end + commentEnd.length;
    lineBreakG.lastIndex = start + 2;
    while (lineBreakG.test(this.input) && lineBreakG.lastIndex <= end) {
      ++this.state.curLine;
      this.state.lineStart = lineBreakG.lastIndex;
    }

    // If we are doing a lookahead right now we need to advance the position (above code)
    // but we do not want to push the comment to the state.
    if (this.isLookahead) return;
    /*:: invariant(startLoc) */

    const comment: N.CommentBlock = {
      type: "CommentBlock",
      value: this.input.slice(start + 2, end),
      start: this.sourceToOffsetPos(start),
      end: this.sourceToOffsetPos(end + commentEnd.length),
      loc: new SourceLocation(startLoc, this.state.curPosition()),
    };
    if (this.optionFlags & OptionFlags.Tokens) this.pushToken(comment);
    return comment;
  }

  /**
   * 跳过行注释
   *
   * @param startSkip 要跳过的起始字符数（通常是双斜杠的长度 2）
   * @returns 如果不是前瞻模式，返回注释对象，否则返回 undefined
   */
  skipLineComment(startSkip: number): N.CommentLine | undefined {
    const start = this.state.pos;
    let startLoc;
    if (!this.isLookahead) startLoc = this.state.curPosition();
    let ch = this.input.charCodeAt((this.state.pos += startSkip));
    if (this.state.pos < this.length) {
      while (!isNewLine(ch) && ++this.state.pos < this.length) {
        ch = this.input.charCodeAt(this.state.pos);
      }
    }

    // If we are doing a lookahead right now we need to advance the position (above code)
    // but we do not want to push the comment to the state.
    if (this.isLookahead) return;

    const end = this.state.pos;
    const value = this.input.slice(start + startSkip, end);

    const comment: N.CommentLine = {
      type: "CommentLine",
      value,
      start: this.sourceToOffsetPos(start),
      end: this.sourceToOffsetPos(end),
      loc: new SourceLocation(startLoc, this.state.curPosition()),
    };
    if (this.optionFlags & OptionFlags.Tokens) this.pushToken(comment);
    return comment;
  }

  // Called at the start of the parse and after every token. Skips
  // whitespace and comments, and.

  // 在解析开始时以及每个标记之后调用。跳过
  // 空格和注释，以及。
  skipSpace(): void {
    const spaceStart = this.state.pos;
    const comments: N.Comment[] =
      this.optionFlags & OptionFlags.AttachComment ? [] : null;
    loop: while (this.state.pos < this.length) {
      const ch = this.input.charCodeAt(this.state.pos);
      switch (ch) {
        case charCodes.space:
        case charCodes.nonBreakingSpace:
        case charCodes.tab:
          ++this.state.pos;
          break;
        case charCodes.carriageReturn:
          if (
            this.input.charCodeAt(this.state.pos + 1) === charCodes.lineFeed
          ) {
            ++this.state.pos;
          }
        // fall through
        case charCodes.lineFeed:
        case charCodes.lineSeparator:
        case charCodes.paragraphSeparator:
          ++this.state.pos;
          ++this.state.curLine;
          this.state.lineStart = this.state.pos;
          break;

        case charCodes.slash:
          switch (this.input.charCodeAt(this.state.pos + 1)) {
            case charCodes.asterisk: {
              const comment = this.skipBlockComment("*/");
              if (comment !== undefined) {
                this.addComment(comment);
                comments?.push(comment);
              }
              break;
            }

            case charCodes.slash: {
              const comment = this.skipLineComment(2);
              if (comment !== undefined) {
                this.addComment(comment);
                comments?.push(comment);
              }
              break;
            }

            default:
              break loop;
          }
          break;

        default:
          if (isWhitespace(ch)) {
            ++this.state.pos;
          } else if (
            ch === charCodes.dash &&
            !this.inModule &&
            this.optionFlags & OptionFlags.AnnexB
          ) {
            const pos = this.state.pos;
            if (
              this.input.charCodeAt(pos + 1) === charCodes.dash &&
              this.input.charCodeAt(pos + 2) === charCodes.greaterThan &&
              (spaceStart === 0 || this.state.lineStart > spaceStart)
            ) {
              // A `-->` line comment
              const comment = this.skipLineComment(3);
              if (comment !== undefined) {
                this.addComment(comment);
                comments?.push(comment);
              }
            } else {
              break loop;
            }
          } else if (
            ch === charCodes.lessThan &&
            !this.inModule &&
            this.optionFlags & OptionFlags.AnnexB
          ) {
            const pos = this.state.pos;
            if (
              this.input.charCodeAt(pos + 1) === charCodes.exclamationMark &&
              this.input.charCodeAt(pos + 2) === charCodes.dash &&
              this.input.charCodeAt(pos + 3) === charCodes.dash
            ) {
              // `<!--`, an XML-style comment that should be interpreted as a line comment
              const comment = this.skipLineComment(4);
              if (comment !== undefined) {
                this.addComment(comment);
                comments?.push(comment);
              }
            } else {
              break loop;
            }
          } else {
            break loop;
          }
      }
    }

    if (comments?.length > 0) {
      const end = this.state.pos;
      const commentWhitespace: CommentWhitespace = {
        start: this.sourceToOffsetPos(spaceStart),
        end: this.sourceToOffsetPos(end),
        comments,
        leadingNode: null,
        trailingNode: null,
        containingNode: null,
      };
      this.state.commentStack.push(commentWhitespace);
    }
  }

  /**
   * Called at the end of every token. Sets `end`, `val`, and
   * maintains `context` and `canStartJSXElement`, and skips the space after
   * the token, so that the next one's `start` will point at the
   * right position.
   *
   * 在每个 token 结束时调用，设置 token 的 `end`、`val` 属性，
   * 维护 `context` 和 `canStartJSXElement`，并跳过 token 后的空白，
   * 使下一个 token 的 `start` 指向正确位置
   *
   * @param type token 类型
   * @param val token 的值（可选）
   */
  finishToken(type: TokenType, val?: any): void {
    this.state.end = this.state.pos;
    this.state.endLoc = this.state.curPosition();
    const prevType = this.state.type;
    this.state.type = type;
    this.state.value = val;

    if (!this.isLookahead) {
      this.updateContext(prevType);
    }
  }

  /**
   * 替换当前 token 的类型
   * 这在需要重新解释已解析的 token 时很有用
   *
   * @param type 新的 token 类型
   */
  replaceToken(type: TokenType): void {
    this.state.type = type;
    // @ts-expect-error the prevType of updateContext is required
    // only when the new type is tt.slash/tt.jsxTagEnd
    this.updateContext();
  }

  // ### Token reading

  // This is the function that is called to fetch the next token. It
  // is somewhat obscure, because it works in character codes rather
  // than characters, and because operator parsing has been inlined
  // into it.
  //
  // All in the name of speed.

  // number sign is "#"

  /**
   * number sign is "#"
   * 读取数字符号 "#" 开头的 token，处理私有字段、记录和元组语法、以及 shebang 等情况
   */
  readToken_numberSign(): void {
    if (this.state.pos === 0 && this.readToken_interpreter()) {
      return;
    }

    const nextPos = this.state.pos + 1;
    const next = this.codePointAtPos(nextPos);
    if (next >= charCodes.digit0 && next <= charCodes.digit9) {
      throw this.raise(
        Errors.UnexpectedDigitAfterHash,
        this.state.curPosition(),
      );
    }

    if (
      !process.env.BABEL_8_BREAKING &&
      (next === charCodes.leftCurlyBrace ||
        (next === charCodes.leftSquareBracket &&
          this.hasPlugin("recordAndTuple")))
    ) {
      // When we see `#{`, it is likely to be a hash record.
      // However we don't yell at `#[` since users may intend to use "computed private fields",
      // which is not allowed in the spec. Throwing expecting recordAndTuple is
      // misleading
      this.expectPlugin("recordAndTuple");
      if (
        !process.env.BABEL_8_BREAKING &&
        this.getPluginOption("recordAndTuple", "syntaxType") === "bar"
      ) {
        throw this.raise(
          next === charCodes.leftCurlyBrace
            ? Errors.RecordExpressionHashIncorrectStartSyntaxType
            : Errors.TupleExpressionHashIncorrectStartSyntaxType,
          this.state.curPosition(),
        );
      }

      this.state.pos += 2;
      if (next === charCodes.leftCurlyBrace) {
        // #{
        this.finishToken(tt.braceHashL);
      } else {
        // #[
        this.finishToken(tt.bracketHashL);
      }
    } else if (isIdentifierStart(next)) {
      ++this.state.pos;
      this.finishToken(tt.privateName, this.readWord1(next));
    } else if (next === charCodes.backslash) {
      ++this.state.pos;
      this.finishToken(tt.privateName, this.readWord1());
    } else {
      this.finishOp(tt.hash, 1);
    }
  }

  /**
   * 读取点号 "." 开头的 token
   * 处理小数点、省略号 "..." 等情况
   */
  readToken_dot(): void {
    const next = this.input.charCodeAt(this.state.pos + 1);
    if (next >= charCodes.digit0 && next <= charCodes.digit9) {
      this.readNumber(true);
      return;
    }

    if (
      next === charCodes.dot &&
      this.input.charCodeAt(this.state.pos + 2) === charCodes.dot
    ) {
      this.state.pos += 3;
      this.finishToken(tt.ellipsis);
    } else {
      ++this.state.pos;
      this.finishToken(tt.dot);
    }
  }

  /**
   * 读取斜杠开头的 token
   * 处理除法操作符和除法赋值操作符
   */
  readToken_slash(): void {
    const next = this.input.charCodeAt(this.state.pos + 1);
    if (next === charCodes.equalsTo) {
      this.finishOp(tt.slashAssign, 2);
    } else {
      this.finishOp(tt.slash, 1);
    }
  }

  /**
   * 读取 shebang 行（解释器指令）
   * 例如：#!/usr/bin/env node
   *
   * @returns 是否成功读取了 shebang 行
   */
  readToken_interpreter(): boolean {
    if (this.state.pos !== 0 || this.length < 2) return false;

    let ch = this.input.charCodeAt(this.state.pos + 1);
    if (ch !== charCodes.exclamationMark) return false;

    const start = this.state.pos;
    this.state.pos += 1;

    while (!isNewLine(ch) && ++this.state.pos < this.length) {
      ch = this.input.charCodeAt(this.state.pos);
    }

    const value = this.input.slice(start + 2, this.state.pos);

    this.finishToken(tt.interpreterDirective, value);

    return true;
  }

  /**
   * 读取乘法和取模操作符
   * 处理星号、百分号、幂运算、赋值运算等操作符
   *
   * @param code 字符代码（星号 或 百分号）
   */
  readToken_mult_modulo(code: number): void {
    // '%' or '*'
    let type = code === charCodes.asterisk ? tt.star : tt.modulo;
    let width = 1;
    let next = this.input.charCodeAt(this.state.pos + 1);

    // Exponentiation operator '**'
    if (code === charCodes.asterisk && next === charCodes.asterisk) {
      width++;
      next = this.input.charCodeAt(this.state.pos + 2);
      type = tt.exponent;
    }

    // '%=' or '*='
    if (next === charCodes.equalsTo && !this.state.inType) {
      width++;
      // `tt.moduloAssign` is only needed to support % as a Hack-pipe topic token.
      // If the proposal ends up choosing a different token,
      // it can be merged with tt.assign.
      type = code === charCodes.percentSign ? tt.moduloAssign : tt.assign;
    }

    this.finishOp(type, width);
  }

  /**
   * 读取管道和与符号操作符
   * 处理竖线、与号、逻辑运算、赋值运算、管道运算等操作符
   *
   * @param code 字符代码（竖线 或 与号）
   */
  readToken_pipe_amp(code: number): void {
    // '||' '&&' '||=' '&&='
    const next = this.input.charCodeAt(this.state.pos + 1);

    if (next === code) {
      if (this.input.charCodeAt(this.state.pos + 2) === charCodes.equalsTo) {
        this.finishOp(tt.assign, 3);
      } else {
        this.finishOp(
          code === charCodes.verticalBar ? tt.logicalOR : tt.logicalAND,
          2,
        );
      }
      return;
    }

    if (code === charCodes.verticalBar) {
      // '|>'
      if (next === charCodes.greaterThan) {
        this.finishOp(tt.pipeline, 2);
        return;
      }
      // '|}'
      if (
        !process.env.BABEL_8_BREAKING &&
        this.hasPlugin("recordAndTuple") &&
        next === charCodes.rightCurlyBrace
      ) {
        if (this.getPluginOption("recordAndTuple", "syntaxType") !== "bar") {
          throw this.raise(
            Errors.RecordExpressionBarIncorrectEndSyntaxType,
            this.state.curPosition(),
          );
        }
        this.state.pos += 2;
        this.finishToken(tt.braceBarR);
        return;
      }

      // '|]'
      if (
        !process.env.BABEL_8_BREAKING &&
        this.hasPlugin("recordAndTuple") &&
        next === charCodes.rightSquareBracket
      ) {
        if (this.getPluginOption("recordAndTuple", "syntaxType") !== "bar") {
          throw this.raise(
            Errors.TupleExpressionBarIncorrectEndSyntaxType,
            this.state.curPosition(),
          );
        }
        this.state.pos += 2;
        this.finishToken(tt.bracketBarR);
        return;
      }
    }

    if (next === charCodes.equalsTo) {
      this.finishOp(tt.assign, 2);
      return;
    }

    this.finishOp(
      code === charCodes.verticalBar ? tt.bitwiseOR : tt.bitwiseAND,
      1,
    );
  }

  /**
   * 读取脱字符开头的 token
   * 处理异或操作符、异或赋值、以及管道操作符提案中的双脱字符
   */
  readToken_caret(): void {
    const next = this.input.charCodeAt(this.state.pos + 1);

    // '^='
    if (next === charCodes.equalsTo && !this.state.inType) {
      // `tt.xorAssign` is only needed to support ^ as a Hack-pipe topic token.
      // If the proposal ends up choosing a different token,
      // it can be merged with tt.assign.
      this.finishOp(tt.xorAssign, 2);
    }
    // '^^'
    else if (
      next === charCodes.caret &&
      // If the ^^ token is not enabled, we don't throw but parse two single ^s
      // because it could be a ^ hack token followed by a ^ binary operator.
      this.hasPlugin([
        "pipelineOperator",
        { proposal: "hack", topicToken: "^^" },
      ])
    ) {
      this.finishOp(tt.doubleCaret, 2);

      // `^^^` is forbidden and must be separated by a space.
      const lookaheadCh = this.input.codePointAt(this.state.pos);
      if (lookaheadCh === charCodes.caret) {
        this.unexpected();
      }
    }
    // '^'
    else {
      this.finishOp(tt.bitwiseXOR, 1);
    }
  }

  /**
   * 读取at符号开头的 token
   * 处理装饰器符号和管道操作符提案中的双at符号
   */
  readToken_atSign(): void {
    const next = this.input.charCodeAt(this.state.pos + 1);

    // '@@'
    if (
      next === charCodes.atSign &&
      this.hasPlugin([
        "pipelineOperator",
        { proposal: "hack", topicToken: "@@" },
      ])
    ) {
      this.finishOp(tt.doubleAt, 2);
    }
    // '@'
    else {
      this.finishOp(tt.at, 1);
    }
  }

  /**
   * 读取加减操作符
   * 处理加号、减号、递增、递减、赋值运算等操作符
   *
   * @param code 字符代码（加号 或 减号）
   */
  readToken_plus_min(code: number): void {
    // '+-'
    const next = this.input.charCodeAt(this.state.pos + 1);

    if (next === code) {
      this.finishOp(tt.incDec, 2);
      return;
    }

    if (next === charCodes.equalsTo) {
      this.finishOp(tt.assign, 2);
    } else {
      this.finishOp(tt.plusMin, 1);
    }
  }

  /**
   * 读取小于号开头的 token
   * 处理小于、小于等于、左移、左移赋值等操作符
   */
  readToken_lt(): void {
    // '<'
    const { pos } = this.state;
    const next = this.input.charCodeAt(pos + 1);

    if (next === charCodes.lessThan) {
      if (this.input.charCodeAt(pos + 2) === charCodes.equalsTo) {
        this.finishOp(tt.assign, 3);
        return;
      }
      this.finishOp(tt.bitShiftL, 2);
      return;
    }

    if (next === charCodes.equalsTo) {
      // <=
      this.finishOp(tt.relational, 2);
      return;
    }

    this.finishOp(tt.lt, 1);
  }

  /**
   * 读取大于号开头的 token
   * 处理大于、大于等于、右移、无符号右移、相应赋值等操作符
   */
  readToken_gt(): void {
    // '>'
    const { pos } = this.state;
    const next = this.input.charCodeAt(pos + 1);

    if (next === charCodes.greaterThan) {
      const size =
        this.input.charCodeAt(pos + 2) === charCodes.greaterThan ? 3 : 2;
      if (this.input.charCodeAt(pos + size) === charCodes.equalsTo) {
        this.finishOp(tt.assign, size + 1);
        return;
      }
      this.finishOp(tt.bitShiftR, size);
      return;
    }

    if (next === charCodes.equalsTo) {
      // <= | >=
      this.finishOp(tt.relational, 2);
      return;
    }

    this.finishOp(tt.gt, 1);
  }

  /**
   * 读取等号和感叹号开头的 token
   * 处理赋值、相等、严格相等、非运算、不等、严格不等、箭头函数等操作符
   *
   * @param code 字符代码（等号 或 感叹号）
   */
  readToken_eq_excl(code: number): void {
    // '=!'
    const next = this.input.charCodeAt(this.state.pos + 1);
    if (next === charCodes.equalsTo) {
      this.finishOp(
        tt.equality,
        this.input.charCodeAt(this.state.pos + 2) === charCodes.equalsTo
          ? 3
          : 2,
      );
      return;
    }
    if (code === charCodes.equalsTo && next === charCodes.greaterThan) {
      // '=>'
      this.state.pos += 2;
      this.finishToken(tt.arrow);
      return;
    }
    this.finishOp(code === charCodes.equalsTo ? tt.eq : tt.bang, 1);
  }

  /**
   * 读取问号开头的 token
   * 处理三元操作符、空值合并、空值合并赋值、可选链等操作符
   */
  readToken_question(): void {
    // '?'
    const next = this.input.charCodeAt(this.state.pos + 1);
    const next2 = this.input.charCodeAt(this.state.pos + 2);
    if (next === charCodes.questionMark) {
      if (next2 === charCodes.equalsTo) {
        // '??='
        this.finishOp(tt.assign, 3);
      } else {
        // '??'
        this.finishOp(tt.nullishCoalescing, 2);
      }
    } else if (
      next === charCodes.dot &&
      !(next2 >= charCodes.digit0 && next2 <= charCodes.digit9)
    ) {
      // '.' not followed by a number
      this.state.pos += 2;
      this.finishToken(tt.questionDot);
    } else {
      ++this.state.pos;
      this.finishToken(tt.question);
    }
  }

  /**
   * This is the function that is called to fetch the next token. It
   * is somewhat obscure, because it works in character codes rather
   * than characters, and because operator parsing has been inlined
   * into it.
   *
   * All in the name of speed.
   *
   * 根据字符代码获取对应的 token，这是词法分析的核心分发方法。
   * 它直接使用字符代码而不是字符，并且将操作符解析内联到其中，
   * 这些都是为了提高速度。
   *
   * @param code Unicode 字符代码
   */
  getTokenFromCode(code: number): void {
    switch (code) {
      // The interpretation of a dot depends on whether it is followed
      // by a digit or another two dots.

      case charCodes.dot:
        this.readToken_dot();
        return;
      // Punctuation tokens.
      case charCodes.leftParenthesis:
        ++this.state.pos;
        this.finishToken(tt.parenL);
        return;
      case charCodes.rightParenthesis:
        ++this.state.pos;
        this.finishToken(tt.parenR);
        return;
      case charCodes.semicolon:
        ++this.state.pos;
        this.finishToken(tt.semi);
        return;
      case charCodes.comma:
        ++this.state.pos;
        this.finishToken(tt.comma);
        return;
      case charCodes.leftSquareBracket:
        if (
          !process.env.BABEL_8_BREAKING &&
          this.hasPlugin("recordAndTuple") &&
          this.input.charCodeAt(this.state.pos + 1) === charCodes.verticalBar
        ) {
          if (this.getPluginOption("recordAndTuple", "syntaxType") !== "bar") {
            throw this.raise(
              Errors.TupleExpressionBarIncorrectStartSyntaxType,
              this.state.curPosition(),
            );
          }

          // [|
          this.state.pos += 2;
          this.finishToken(tt.bracketBarL);
        } else {
          ++this.state.pos;
          this.finishToken(tt.bracketL);
        }
        return;
      case charCodes.rightSquareBracket:
        ++this.state.pos;
        this.finishToken(tt.bracketR);
        return;
      case charCodes.leftCurlyBrace:
        if (
          !process.env.BABEL_8_BREAKING &&
          this.hasPlugin("recordAndTuple") &&
          this.input.charCodeAt(this.state.pos + 1) === charCodes.verticalBar
        ) {
          if (this.getPluginOption("recordAndTuple", "syntaxType") !== "bar") {
            throw this.raise(
              Errors.RecordExpressionBarIncorrectStartSyntaxType,
              this.state.curPosition(),
            );
          }

          // {|
          this.state.pos += 2;
          this.finishToken(tt.braceBarL);
        } else {
          ++this.state.pos;
          this.finishToken(tt.braceL);
        }
        return;
      case charCodes.rightCurlyBrace:
        ++this.state.pos;
        this.finishToken(tt.braceR);
        return;

      case charCodes.colon:
        if (
          this.hasPlugin("functionBind") &&
          this.input.charCodeAt(this.state.pos + 1) === charCodes.colon
        ) {
          this.finishOp(tt.doubleColon, 2);
        } else {
          ++this.state.pos;
          this.finishToken(tt.colon);
        }
        return;

      case charCodes.questionMark:
        this.readToken_question();
        return;

      case charCodes.graveAccent:
        this.readTemplateToken();
        return;

      case charCodes.digit0: {
        const next = this.input.charCodeAt(this.state.pos + 1);
        // '0x', '0X' - hex number
        if (next === charCodes.lowercaseX || next === charCodes.uppercaseX) {
          this.readRadixNumber(16);
          return;
        }
        // '0o', '0O' - octal number
        if (next === charCodes.lowercaseO || next === charCodes.uppercaseO) {
          this.readRadixNumber(8);
          return;
        }
        // '0b', '0B' - binary number
        if (next === charCodes.lowercaseB || next === charCodes.uppercaseB) {
          this.readRadixNumber(2);
          return;
        }
      }
      // Anything else beginning with a digit is an integer, octal
      // number, or float. (fall through)
      case charCodes.digit1:
      case charCodes.digit2:
      case charCodes.digit3:
      case charCodes.digit4:
      case charCodes.digit5:
      case charCodes.digit6:
      case charCodes.digit7:
      case charCodes.digit8:
      case charCodes.digit9:
        this.readNumber(false);
        return;

      // Quotes produce strings.
      case charCodes.quotationMark:
      case charCodes.apostrophe:
        this.readString(code);
        return;

      // Operators are parsed inline in tiny state machines. '=' (charCodes.equalsTo) is
      // often referred to. `finishOp` simply skips the amount of
      // characters it is given as second argument, and returns a token
      // of the type given by its first argument.

      case charCodes.slash:
        this.readToken_slash();
        return;

      case charCodes.percentSign:
      case charCodes.asterisk:
        this.readToken_mult_modulo(code);
        return;

      case charCodes.verticalBar:
      case charCodes.ampersand:
        this.readToken_pipe_amp(code);
        return;

      case charCodes.caret:
        this.readToken_caret();
        return;

      case charCodes.plusSign:
      case charCodes.dash:
        this.readToken_plus_min(code);
        return;

      case charCodes.lessThan:
        this.readToken_lt();
        return;

      case charCodes.greaterThan:
        this.readToken_gt();
        return;

      case charCodes.equalsTo:
      case charCodes.exclamationMark:
        this.readToken_eq_excl(code);
        return;

      case charCodes.tilde:
        this.finishOp(tt.tilde, 1);
        return;

      case charCodes.atSign:
        this.readToken_atSign();
        return;

      case charCodes.numberSign:
        this.readToken_numberSign();
        return;

      case charCodes.backslash:
        this.readWord();
        return;

      default:
        if (isIdentifierStart(code)) {
          this.readWord(code);
          return;
        }
    }

    throw this.raise(
      Errors.InvalidOrUnexpectedToken,
      this.state.curPosition(),
      {
        unexpected: String.fromCodePoint(code),
      },
    );
  }

  /**
   * 完成操作符 token 的创建
   * 提取指定长度的字符串作为 token 值并完成 token 创建
   *
   * @param type 操作符 token 类型
   * @param size 操作符的字符长度
   */
  finishOp(type: TokenType, size: number): void {
    const str = this.input.slice(this.state.pos, this.state.pos + size);
    this.state.pos += size;
    this.finishToken(type, str);
  }

  /**
   * 读取正则表达式字面量
   * 解析正则表达式模式和修饰符，处理转义字符和字符类
   */
  readRegexp(): void {
    const startLoc = this.state.startLoc;
    const start = this.state.start + 1;
    let escaped, inClass;
    let { pos } = this.state;
    for (; ; ++pos) {
      if (pos >= this.length) {
        // FIXME: explain
        throw this.raise(
          Errors.UnterminatedRegExp,
          createPositionWithColumnOffset(startLoc, 1),
        );
      }
      const ch = this.input.charCodeAt(pos);
      if (isNewLine(ch)) {
        throw this.raise(
          Errors.UnterminatedRegExp,
          createPositionWithColumnOffset(startLoc, 1),
        );
      }
      if (escaped) {
        escaped = false;
      } else {
        if (ch === charCodes.leftSquareBracket) {
          inClass = true;
        } else if (ch === charCodes.rightSquareBracket && inClass) {
          inClass = false;
        } else if (ch === charCodes.slash && !inClass) {
          break;
        }
        escaped = ch === charCodes.backslash;
      }
    }
    const content = this.input.slice(start, pos);
    ++pos;

    let mods = "";

    const nextPos = () =>
      // (pos + 1) + 1 - start
      createPositionWithColumnOffset(startLoc, pos + 2 - start);

    while (pos < this.length) {
      const cp = this.codePointAtPos(pos);
      // It doesn't matter if cp > 0xffff, the loop will either throw or break because we check on cp
      const char = String.fromCharCode(cp);

      // @ts-expect-error VALID_REGEX_FLAGS.has should accept expanded type: number
      if (VALID_REGEX_FLAGS.has(cp)) {
        if (cp === charCodes.lowercaseV) {
          if (mods.includes("u")) {
            this.raise(Errors.IncompatibleRegExpUVFlags, nextPos());
          }
        } else if (cp === charCodes.lowercaseU) {
          if (mods.includes("v")) {
            this.raise(Errors.IncompatibleRegExpUVFlags, nextPos());
          }
        }
        if (mods.includes(char)) {
          this.raise(Errors.DuplicateRegExpFlags, nextPos());
        }
      } else if (isIdentifierChar(cp) || cp === charCodes.backslash) {
        this.raise(Errors.MalformedRegExpFlags, nextPos());
      } else {
        break;
      }

      ++pos;
      mods += char;
    }
    this.state.pos = pos;

    this.finishToken(tt.regexp, {
      pattern: content,
      flags: mods,
    });
  }

  /**
   * Read an integer in the given radix. Return null if zero digits
   * were read, the integer value otherwise. When `len` is given, this
   * will return `null` unless the integer has exactly `len` digits.
   * When `forceLen` is `true`, it means that we already know that in case
   * of a malformed number we have to skip `len` characters anyway, instead
   * of bailing out early. For example, in "\u{123Z}" we want to read up to }
   * anyway, while in "\u00Z" we will stop at Z instead of consuming four
   * characters (and thus the closing quote).
   *
   * 读取指定进制的整数。如果读取了0个数字则返回null，否则返回整数值。
   * 当指定`len`时，除非整数恰好有`len`个数字，否则返回`null`。
   * 当`forceLen`为`true`时，意味着在格式错误的数字情况下，我们仍需跳过`len`个字符，
   * 而不是提前退出。例如，在"\u{123Z}"中我们想读到}，而在"\u00Z"中会在Z处停止。
   *
   * @param radix 进制（2、8、10、16等）
   * @param len 预期的数字长度，如果指定则必须精确匹配
   * @param forceLen 是否强制读取指定长度
   * @param allowNumSeparator 是否允许数字分隔符
   * @returns 解析出的整数值，如果读取了0个数字则返回null
   */
  readInt(
    radix: number,
    len?: number,
    forceLen: boolean = false,
    allowNumSeparator: boolean | "bail" = true,
  ): number | null {
    const { n, pos } = readInt(
      this.input,
      this.state.pos,
      this.state.lineStart,
      this.state.curLine,
      radix,
      len,
      forceLen,
      allowNumSeparator,
      this.errorHandlers_readInt,
      /* bailOnError */ false,
    );
    this.state.pos = pos;
    return n;
  }

  /**
   * 读取指定进制的数字字面量
   * 处理 0x、0o、0b 等进制前缀的数字，以及 BigInt 后缀
   *
   * @param radix 进制（2、8、16）
   */
  readRadixNumber(radix: number): void {
    const start = this.state.pos;
    const startLoc = this.state.curPosition();
    let isBigInt = false;

    this.state.pos += 2; // 0x
    const val = this.readInt(radix);
    if (val == null) {
      this.raise(
        Errors.InvalidDigit,
        // Numeric literals can't have newlines, so this is safe to do.
        createPositionWithColumnOffset(startLoc, 2),
        {
          radix,
        },
      );
    }
    const next = this.input.charCodeAt(this.state.pos);

    if (next === charCodes.lowercaseN) {
      ++this.state.pos;
      isBigInt = true;
    } else if (next === charCodes.lowercaseM) {
      throw this.raise(Errors.InvalidDecimal, startLoc);
    }

    if (isIdentifierStart(this.codePointAtPos(this.state.pos))) {
      throw this.raise(Errors.NumberIdentifier, this.state.curPosition());
    }

    if (isBigInt) {
      const str = this.input.slice(start, this.state.pos).replace(/[_n]/g, "");
      this.finishToken(tt.bigint, str);
      return;
    }

    this.finishToken(tt.num, val);
  }

  /**
   * Read an integer, octal integer, or floating-point number.
   * 读取整数、八进制整数或浮点数
   * 处理各种数字格式：十进制、八进制、浮点数、科学计数法、BigInt、Decimal
   *
   * @param startsWithDot 是否以小数点开始（如 .5）
   */
  readNumber(startsWithDot: boolean): void {
    const start = this.state.pos;
    const startLoc = this.state.curPosition();
    let isFloat = false;
    let isBigInt = false;
    let hasExponent = false;
    let isOctal = false;

    if (!startsWithDot && this.readInt(10) === null) {
      this.raise(Errors.InvalidNumber, this.state.curPosition());
    }
    const hasLeadingZero =
      this.state.pos - start >= 2 &&
      this.input.charCodeAt(start) === charCodes.digit0;

    if (hasLeadingZero) {
      const integer = this.input.slice(start, this.state.pos);
      this.recordStrictModeErrors(Errors.StrictOctalLiteral, startLoc);
      if (!this.state.strict) {
        // disallow numeric separators in non octal decimals and legacy octal likes
        const underscorePos = integer.indexOf("_");
        if (underscorePos > 0) {
          // Numeric literals can't have newlines, so this is safe to do.
          this.raise(
            Errors.ZeroDigitNumericSeparator,
            createPositionWithColumnOffset(startLoc, underscorePos),
          );
        }
      }
      isOctal = hasLeadingZero && !/[89]/.test(integer);
    }

    let next = this.input.charCodeAt(this.state.pos);
    if (next === charCodes.dot && !isOctal) {
      ++this.state.pos;
      this.readInt(10);
      isFloat = true;
      next = this.input.charCodeAt(this.state.pos);
    }

    if (
      (next === charCodes.uppercaseE || next === charCodes.lowercaseE) &&
      !isOctal
    ) {
      next = this.input.charCodeAt(++this.state.pos);
      if (next === charCodes.plusSign || next === charCodes.dash) {
        ++this.state.pos;
      }
      if (this.readInt(10) === null) {
        this.raise(Errors.InvalidOrMissingExponent, startLoc);
      }
      isFloat = true;
      hasExponent = true;
      next = this.input.charCodeAt(this.state.pos);
    }

    if (next === charCodes.lowercaseN) {
      // disallow floats, legacy octal syntax and non octal decimals
      // new style octal ("0o") is handled in this.readRadixNumber
      if (isFloat || hasLeadingZero) {
        this.raise(Errors.InvalidBigIntLiteral, startLoc);
      }
      ++this.state.pos;
      isBigInt = true;
    }

    if (!process.env.BABEL_8_BREAKING && next === charCodes.lowercaseM) {
      this.expectPlugin("decimal", this.state.curPosition());
      if (hasExponent || hasLeadingZero) {
        this.raise(Errors.InvalidDecimal, startLoc);
      }
      ++this.state.pos;
      // eslint-disable-next-line no-var
      var isDecimal = true;
    }

    if (isIdentifierStart(this.codePointAtPos(this.state.pos))) {
      throw this.raise(Errors.NumberIdentifier, this.state.curPosition());
    }

    // remove "_" for numeric literal separator, and trailing `m` or `n`
    const str = this.input.slice(start, this.state.pos).replace(/[_mn]/g, "");

    if (isBigInt) {
      this.finishToken(tt.bigint, str);
      return;
    }

    if (!process.env.BABEL_8_BREAKING && isDecimal) {
      this.finishToken(tt.decimal, str);
      return;
    }

    const val = isOctal ? parseInt(str, 8) : parseFloat(str);
    this.finishToken(tt.num, val);
  }

  /**
   * Read a string value, interpreting backslash-escapes.
   * 读取字符串值，解释反斜杠转义序列
   *
   * @param throwOnInvalid 遇到无效码点时是否抛出错误
   * @returns Unicode 码点值，如果无效则返回 null
   */
  readCodePoint(throwOnInvalid: boolean): number | null {
    const { code, pos } = readCodePoint(
      this.input,
      this.state.pos,
      this.state.lineStart,
      this.state.curLine,
      throwOnInvalid,
      this.errorHandlers_readCodePoint,
    );
    this.state.pos = pos;
    return code;
  }

  /**
   * 读取字符串字面量
   * 处理转义字符和多行字符串
   *
   * @param quote 引号字符代码（单引号或双引号）
   */
  readString(quote: number): void {
    const { str, pos, curLine, lineStart } = readStringContents(
      quote === charCodes.quotationMark ? "double" : "single",
      this.input,
      this.state.pos + 1, // skip the quote
      this.state.lineStart,
      this.state.curLine,
      this.errorHandlers_readStringContents_string,
    );
    this.state.pos = pos + 1; // skip the quote
    this.state.lineStart = lineStart;
    this.state.curLine = curLine;
    this.finishToken(tt.string, str);
  }

  /**
   * Reads template continuation `}...`
   * 读取模板字符串的继续部分，用于处理模板字符串中表达式后的部分
   */
  readTemplateContinuation(): void {
    if (!this.match(tt.braceR)) {
      this.unexpected(null, tt.braceR);
    }
    // rewind pos to `}`
    this.state.pos--;
    this.readTemplateToken();
  }

  /**
   * Reads template string tokens.
   * 读取模板字符串 token，处理模板字符串的各个部分，包括开始、中间和结束部分
   */
  readTemplateToken(): void {
    const opening = this.input[this.state.pos];
    const { str, firstInvalidLoc, pos, curLine, lineStart } =
      readStringContents(
        "template",
        this.input,
        this.state.pos + 1, // skip '`' or `}`
        this.state.lineStart,
        this.state.curLine,
        this.errorHandlers_readStringContents_template,
      );
    this.state.pos = pos + 1; // skip '`' or `$`
    this.state.lineStart = lineStart;
    this.state.curLine = curLine;

    if (firstInvalidLoc) {
      this.state.firstInvalidTemplateEscapePos = new Position(
        firstInvalidLoc.curLine,
        firstInvalidLoc.pos - firstInvalidLoc.lineStart,
        this.sourceToOffsetPos(firstInvalidLoc.pos),
      );
    }

    if (this.input.codePointAt(pos) === charCodes.graveAccent) {
      this.finishToken(
        tt.templateTail,
        firstInvalidLoc ? null : opening + str + "`",
      );
    } else {
      this.state.pos++; // skip '{'
      this.finishToken(
        tt.templateNonTail,
        firstInvalidLoc ? null : opening + str + "${",
      );
    }
  }

  /**
   * 记录严格模式错误
   * 在严格模式下立即抛出错误，否则暂存错误待后续处理
   *
   * @param toParseError 延迟的严格模式错误构造函数
   * @param at 错误位置
   */
  recordStrictModeErrors(toParseError: DeferredStrictError, at: Position) {
    const index = at.index;

    if (this.state.strict && !this.state.strictErrors.has(index)) {
      this.raise(toParseError, at);
    } else {
      this.state.strictErrors.set(index, [toParseError, at]);
    }
  }

  /**
   * Read an identifier, and return it as a string. Sets `this.state.containsEsc`
   * to whether the word contained a '\u' escape.
   *
   * Incrementally adds only escaped chars, adding other chunks as-is
   * as a micro-optimization.
   *
   * When `firstCode` is given, it assumes it is always an identifier start and
   * will skip reading start position again
   *
   * 读取标识符并返回字符串，设置 `this.state.containsEsc` 标记单词是否包含 '\u' 转义
   * 为了微优化，只增量添加转义字符，其他块按原样添加
   * 当提供 `firstCode` 时，假定它总是标识符开始，会跳过重新读取开始位置
   *
   * @param firstCode 第一个字符的 Unicode 码点（可选）
   * @returns 读取到的标识符字符串
   */
  readWord1(firstCode?: number): string {
    this.state.containsEsc = false;
    let word = "";
    const start = this.state.pos;
    let chunkStart = this.state.pos;
    if (firstCode !== undefined) {
      this.state.pos += firstCode <= 0xffff ? 1 : 2;
    }

    while (this.state.pos < this.length) {
      const ch = this.codePointAtPos(this.state.pos);
      if (isIdentifierChar(ch)) {
        this.state.pos += ch <= 0xffff ? 1 : 2;
      } else if (ch === charCodes.backslash) {
        this.state.containsEsc = true;

        word += this.input.slice(chunkStart, this.state.pos);
        const escStart = this.state.curPosition();
        const identifierCheck =
          this.state.pos === start ? isIdentifierStart : isIdentifierChar;

        if (this.input.charCodeAt(++this.state.pos) !== charCodes.lowercaseU) {
          this.raise(Errors.MissingUnicodeEscape, this.state.curPosition());
          chunkStart = this.state.pos - 1;
          continue;
        }

        ++this.state.pos;
        const esc = this.readCodePoint(true);
        if (esc !== null) {
          if (!identifierCheck(esc)) {
            this.raise(Errors.EscapedCharNotAnIdentifier, escStart);
          }

          word += String.fromCodePoint(esc);
        }
        chunkStart = this.state.pos;
      } else {
        break;
      }
    }
    return word + this.input.slice(chunkStart, this.state.pos);
  }

  /**
   * Read an identifier or keyword token. Will check for reserved
   * words when necessary.
   * 读取标识符或关键字 token，必要时检查保留字，决定是创建关键字 token 还是标识符 token
   *
   * @param firstCode 第一个字符的 Unicode 码点（可选）
   */
  readWord(firstCode?: number): void {
    const word = this.readWord1(firstCode);
    const type = keywordTypes.get(word);
    if (type !== undefined) {
      // We don't use word as state.value here because word is a dynamic string
      // while token label is a shared constant string
      this.finishToken(type, tokenLabelName(type));
    } else {
      this.finishToken(tt.name, word);
    }
  }

  /**
   * Check for escaped reserved words in keywords.
   * 检查关键词中的转义保留字
   */
  checkKeywordEscapes(): void {
    const { type } = this.state;
    if (tokenIsKeyword(type) && this.state.containsEsc) {
      this.raise(Errors.InvalidEscapedReservedWord, this.state.startLoc, {
        reservedWord: tokenLabelName(type),
      });
    }
  }

  /**
   * Raise a `ParseError` given the appropriate properties. If passed a
   * `Position` for the `at` property, raises the `ParseError` at that location.
   * Otherwise, if passed a `Node`, raises the `ParseError` at the start
   * location of that `Node`.
   *
   * If `errorRecovery` is `true`, the error is pushed to the errors array and
   * returned. If `errorRecovery` is `false`, the error is instead thrown.
   *
   * The return type is marked as `never` for simplicity, as error recovery
   * will create types in an invalid AST shape.
   *
   * 给定适当的属性，抛出 `ParseError` 异常。如果传入了 `at` 属性的 `Position`，则在该位置抛出 `ParseError` 异常。
   * 否则，如果传入了 `Node`，则在该 `Node` 的起始位置抛出 `ParseError` 异常。
   *
   * 如果 `errorRecovery` 为 `true`，则将错误推送到错误数组并
   * 返回。如果 `errorRecovery` 为 `false`，则抛出错误。
   *
   * 为简单起见，返回类型标记为 `never`，因为错误恢复
   * 将创建无效 AST 形状的类型。
   */
  raise<ErrorDetails = object>(
    toParseError: ParseErrorConstructor<ErrorDetails>,
    at: Position | Undone<Node>,
    details: ErrorDetails = {} as ErrorDetails,
  ): ParseError<ErrorDetails> {
    const loc = at instanceof Position ? at : at.loc.start;
    const error = toParseError(loc, details);

    if (!(this.optionFlags & OptionFlags.ErrorRecovery)) throw error;
    if (!this.isLookahead) this.state.errors.push(error);

    return error;
  }

  /**
   * 覆盖式抛出解析错误
   * 如果 `errorRecovery` 为 `false`，此方法与 `raise` 完全相同
   * 如果 `errorRecovery` 为 `true`，此方法会先检查相同位置是否已有错误，
   * 如果有则用新生成的错误替换它
   *
   * @param toParseError 错误构造函数
   * @param at 错误位置或节点
   * @param details 错误详情
   * @returns 解析错误对象
   */
  raiseOverwrite<ErrorDetails>(
    toParseError: ParseErrorConstructor<ErrorDetails>,
    at: Position | Undone<Node>,
    details: ErrorDetails = {} as ErrorDetails,
  ): ParseError<ErrorDetails> | never {
    const loc = at instanceof Position ? at : at.loc.start;
    const pos = loc.index;
    const errors = this.state.errors;

    for (let i = errors.length - 1; i >= 0; i--) {
      const error = errors[i];
      if (error.loc.index === pos) {
        return (errors[i] = toParseError(loc, details));
      }
      if (error.loc.index < pos) break;
    }

    return this.raise(toParseError, at, details);
  }

  /**
   * updateContext is used by the jsx plugin
   * 更新 token 上下文，此方法由 JSX 插件使用，用于在不同 token 间维护正确的解析上下文
   *
   * @param prevType 前一个 token 的类型
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  updateContext(prevType: TokenType): void {}

  /**
   * Raise an unexpected token error. Can take the expected token type.
   * 抛出意外 token 错误
   *
   * @param loc 错误位置（可选，默认使用当前位置）
   * @param type 期望的 token 类型（可选）
   */
  unexpected(loc?: Position | null, type?: TokenType): void {
    throw this.raise(
      Errors.UnexpectedToken,
      loc != null ? loc : this.state.startLoc,
      {
        expected: type ? tokenLabelName(type) : null,
      },
    );
  }

  /**
   * 期望特定插件已启用
   * 如果插件未启用则抛出错误
   *
   * @param pluginName 插件名称
   * @param loc 错误位置（可选）
   * @returns 总是返回 true（如果没抛出错误）
   */
  expectPlugin(pluginName: Plugin, loc?: Position): true {
    if (this.hasPlugin(pluginName)) {
      return true;
    }

    throw this.raise(
      Errors.MissingPlugin,
      loc != null ? loc : this.state.startLoc,
      {
        missingPlugin: [pluginName],
      },
    );
  }

  /**
   * 期望插件列表中至少有一个插件已启用
   * 如果没有任何一个插件启用则抛出错误
   *
   * @param pluginNames 插件名称数组
   */
  expectOnePlugin(pluginNames: Plugin[]): void {
    if (!pluginNames.some(name => this.hasPlugin(name))) {
      throw this.raise(Errors.MissingOneOfPlugins, this.state.startLoc, {
        missingPlugin: pluginNames,
      });
    }
  }

  /**
   * 错误构建器
   * 创建一个函数，该函数可以在指定位置构建并抛出指定类型的错误
   *
   * @param error 错误构造函数
   * @returns 错误构建函数
   */
  errorBuilder(error: ParseErrorConstructor<object>) {
    return (pos: number, lineStart: number, curLine: number) => {
      this.raise(error, buildPosition(pos, lineStart, curLine));
    };
  }

  errorHandlers_readInt: IntErrorHandlers = {
    invalidDigit: (pos, lineStart, curLine, radix) => {
      if (!(this.optionFlags & OptionFlags.ErrorRecovery)) return false;

      this.raise(Errors.InvalidDigit, buildPosition(pos, lineStart, curLine), {
        radix,
      });
      // Continue parsing the number as if there was no invalid digit.
      return true;
    },
    numericSeparatorInEscapeSequence: this.errorBuilder(
      Errors.NumericSeparatorInEscapeSequence,
    ),
    unexpectedNumericSeparator: this.errorBuilder(
      Errors.UnexpectedNumericSeparator,
    ),
  };

  errorHandlers_readCodePoint: CodePointErrorHandlers = {
    ...this.errorHandlers_readInt,
    invalidEscapeSequence: this.errorBuilder(Errors.InvalidEscapeSequence),
    invalidCodePoint: this.errorBuilder(Errors.InvalidCodePoint),
  };

  errorHandlers_readStringContents_string: StringContentsErrorHandlers = {
    ...this.errorHandlers_readCodePoint,
    strictNumericEscape: (pos, lineStart, curLine) => {
      this.recordStrictModeErrors(
        Errors.StrictNumericEscape,
        buildPosition(pos, lineStart, curLine),
      );
    },
    unterminated: (pos, lineStart, curLine) => {
      throw this.raise(
        Errors.UnterminatedString, // Report the error at the string quote
        buildPosition(pos - 1, lineStart, curLine),
      );
    },
  };

  errorHandlers_readStringContents_template: StringContentsErrorHandlers = {
    ...this.errorHandlers_readCodePoint,
    strictNumericEscape: this.errorBuilder(Errors.StrictNumericEscape),
    unterminated: (pos, lineStart, curLine) => {
      throw this.raise(
        Errors.UnterminatedTemplate,
        buildPosition(pos, lineStart, curLine),
      );
    },
  };
}
