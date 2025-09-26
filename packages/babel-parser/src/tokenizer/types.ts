import { types as tc, type TokContext } from "./context.ts";
// ## Token types

// The assignment of fine-grained, information-carrying type objects
// allows the tokenizer to store the information it has about a
// token in a way that is very cheap for the parser to look up.

// All token type variables start with an underscore, to make them
// easy to recognize.

// The `beforeExpr` property is used to disambiguate between 1) binary
// expression (<) and JSX Tag start (<name>); 2) object literal and JSX
// texts. It is set on the `updateContext` function in the JSX plugin.

// The `startsExpr` property is used to determine whether an expression
// may be the “argument” subexpression of a `yield` expression or
// `yield` statement. It is set on all token types that may be at the
// start of a subexpression.

// `isLoop` marks a keyword as starting a loop, which is important
// to know when parsing a label, in order to allow or disallow
// continue jumps to that label.

// 细粒度、信息承载类型对象的肤质
// 允许标记器以一种对解析器来说查找开销极低的方式存储其拥有的关于标记的信息
// 所有标记类型变量都以下划线开头，以便于识别
// `beforeExpr` 属性用于区分 1）二进制
// 表达式（<）和 JSX 标签开头（<name>）; 2）对象字面量和 JSX
// 文本。该属性在 JSX 插件中的 `updateContext` 函数中设置。

// `startsExpr` 属性用于确定表达式
// 是否可能是 `yield` 表达式或
// `yield` 语句的“参数”子表达式。该属性在所有可能位于
// 子表达式开头的标记类型上设置。

// `isLoop` 标记关键字为循环开始，这一点很重要
// 需要在解析标签时了解，以便允许或禁止
// continue 跳转到该标签

const beforeExpr = true;
const startsExpr = true;
const isLoop = true;
const isAssign = true;
const prefix = true;
const postfix = true;

type TokenOptions = {
  keyword?: string;
  beforeExpr?: boolean;
  startsExpr?: boolean;
  rightAssociative?: boolean;
  isLoop?: boolean;
  isAssign?: boolean;
  prefix?: boolean;
  postfix?: boolean;
  binop?: number | null;
};

// Internally the tokenizer stores token as a number
export type TokenType = number;

// The `ExportedTokenType` is exported via `tokTypes` and accessible
// when `tokens: true` is enabled. Unlike internal token type, it provides
// metadata of the tokens.
export class ExportedTokenType {
  label: string;
  keyword: string | undefined | null;
  beforeExpr: boolean;
  startsExpr: boolean;
  rightAssociative: boolean;
  isLoop: boolean;
  isAssign: boolean;
  prefix: boolean;
  postfix: boolean;
  binop: number | undefined | null;
  // todo(Babel 8): remove updateContext from exposed token layout
  declare updateContext:
    | ((context: Array<TokContext>) => void)
    | undefined
    | null;

  constructor(label: string, conf: TokenOptions = {}) {
    this.label = label;
    this.keyword = conf.keyword;
    this.beforeExpr = !!conf.beforeExpr;
    this.startsExpr = !!conf.startsExpr;
    this.rightAssociative = !!conf.rightAssociative;
    this.isLoop = !!conf.isLoop;
    this.isAssign = !!conf.isAssign;
    this.prefix = !!conf.prefix;
    this.postfix = !!conf.postfix;
    this.binop = conf.binop != null ? conf.binop : null;
    if (!process.env.BABEL_8_BREAKING) {
      this.updateContext = null;
    }
  }
}

// A map from keyword/keyword-like string value to the token type
export const keywords = new Map<string, TokenType>();

function createKeyword(name: string, options: TokenOptions = {}): TokenType {
  options.keyword = name;
  const token = createToken(name, options);
  keywords.set(name, token);
  return token;
}

/**
 * 创建二元操作符 Token 的便捷工具函数
 * Convenience function for creating binary operator tokens
 *
 * 这个函数是专门用于简化二元操作符创建的工具函数，它自动设置了
 * 二元操作符必需的属性，避免重复编写配置代码。
 *
 * 🎯 主要作用：
 * 1. 简化二元操作符 token 的创建过程
 * 2. 自动设置 beforeExpr: true（操作符前可以有表达式）
 * 3. 统一二元操作符的创建方式，提高代码一致性
 *
 * 🔧 自动设置的属性：
 * • beforeExpr: true - 标记操作符前面可以有表达式
 * • binop: number - 设置操作符的优先级
 *
 * 💡 设计优势：
 * - 代码简洁：避免重复编写 { beforeExpr, binop } 配置
 * - 语义清晰：函数名明确表达创建二元操作符的意图
 * - 一致性保证：确保所有二元操作符都有正确的 beforeExpr 属性
 * - 维护便利：集中管理二元操作符的创建逻辑
 *
 * 📝 使用示例：
 * ```typescript
 * // 简洁的写法
 * logicalOR: createBinop("||", 1)      // 逻辑或，优先级 1
 * logicalAND: createBinop("&&", 2)     // 逻辑与，优先级 2
 * equality: createBinop("==", 6)       // 相等比较，优先级 6
 * relational: createBinop("<", 7)      // 关系比较，优先级 7
 *
 * // 等价的完整写法（更冗长）
 * logicalOR: createToken("||", { beforeExpr: true, binop: 1 })
 * ```
 *
 * 🔢 优先级参考：
 * 0: |> (管道) < 1: ||,?? (逻辑) < 2: && < 3: | < 4: ^ < 5: &
 * < 6: == (相等) < 7: <,> (关系) < 8: << (位移) < 9: +,- < 10: *,/,% < 11: **
 *
 * @param name - 操作符名称或描述（如 "||", "+/-", "==/!=="）
 * @param binop - 二元操作符优先级（数字越大优先级越高）
 * @returns 返回配置好的 token 类型 ID
 */
function createBinop(name: string, binop: number) {
  return createToken(name, { beforeExpr, binop });
}

let tokenTypeCounter = -1;
export const tokenTypes: ExportedTokenType[] = [];
const tokenLabels: string[] = [];
const tokenBinops: number[] = [];
const tokenBeforeExprs: boolean[] = [];
const tokenStartsExprs: boolean[] = [];
const tokenPrefixes: boolean[] = [];

/**
 * Token 类型创建工厂函数
 *
 * 这个函数是 Babel 词法分析系统的核心工厂函数，负责创建和注册新的 token 类型。
 * 它采用了高度优化的数据结构设计，为后续的高频属性查找提供 O(1) 性能保证。
 *
 * ## 设计优势
 *
 * ### 1. 数字化 Token 标识符
 * - 为每个 token 类型分配唯一的递增数字 ID
 * - 数字比较比字符串比较快数倍
 * - 避免了字符串哈希计算的开销
 *
 * ### 2. 结构体数组 (Structure of Arrays) 设计模式
 * 使用并行数组存储不同属性，而不是对象数组：
 * ```
 * ❌ 对象数组方式 (慢):
 * tokens = [
 *   {name: "[", beforeExpr: true, startsExpr: true},
 *   {name: "]", beforeExpr: false, startsExpr: false}
 * ]
 *
 * ✅ 并行数组方式 (快):
 * tokenLabels      = ["[", "]", ...]
 * tokenBeforeExprs = [true, false, ...]
 * tokenStartsExprs = [true, false, ...]
 * ```
 *
 * ### 3. O(1) 属性查找性能
 * 通过数组索引直接访问，避免对象属性查找的哈希计算：
 * ```javascript
 * // 对象属性查找 (慢) - 涉及哈希计算
 * obj["bracketL"].startsExpr  // 需要计算 "bracketL" 和 "startsExpr" 的哈希值
 *
 * // 数组索引访问 (快) - 纯算术运算
 * tokenStartsExprs[token]     // 内存地址 = 基址 + token * 元素大小
 * ```
 *
 * ### 4. 内存局部性优化
 * - 相同类型的属性连续存储，提高 CPU 缓存命中率
 * - 减少内存碎片，提升访问效率
 * - 对于频繁的属性查找场景（解析过程中数百万次调用）性能提升显著
 *
 * ### 5. 类型安全与扩展性
 * - TokenType 强类型定义，避免类型混淆
 * - 统一的创建接口，便于添加新的 token 类型
 * - 自动同步所有属性数组，保证数据一致性
 *
 * ## 性能对比
 *
 * 在大型 JavaScript 文件解析过程中：
 * - 数组索引访问：~1ns per lookup
 * - 对象属性访问：~5-10ns per lookup
 * - 对于百万级别的 token 处理，性能提升可达 5-10 倍
 *
 * ## 工作流程
 *
 * 1. 生成唯一数字 ID (tokenTypeCounter++)
 * 2. 将各属性分别推入对应的并行数组
 * 3. 创建 ExportedTokenType 实例用于外部 API
 * 4. 返回数字 ID 作为 TokenType
 *
 * ## options 参数详解
 *
 * options 是 TokenOptions 类型的配置对象，用于为每个 token 类型定义语法语义属性。
 * 这些属性指导解析器如何正确处理该 token，影响语法分析的决策过程。
 *
 * ### 🔤 keyword?: string
 * 标记这个 token 是否为关键字，以及关键字的具体内容
 * ```javascript
 * createKeyword("if")  // options.keyword = "if"
 * createKeyword("for") // options.keyword = "for"
 * ```
 *
 * ### ⚡ beforeExpr?: boolean
 * 表示此 token 前面是否可以有表达式，用于区分语法歧义（特别是 JSX）
 * ```javascript
 * createToken(",", { beforeExpr })     // 逗号前可以有表达式
 * createToken("(", { beforeExpr })     // 左括号前可以有表达式：obj()
 * createToken("=", { beforeExpr })     // 等号前可以有表达式：a = b
 * ```
 *
 * ### 🚀 startsExpr?: boolean
 * 表示此 token 是否可以开始一个表达式，用于确定 yield 表达式的参数解析
 * ```javascript
 * createToken("[", { startsExpr })     // [ 可以开始数组表达式：[1, 2, 3]
 * createToken("(", { startsExpr })     // ( 可以开始括号表达式：(a + b)
 * createKeyword("this", { startsExpr }) // this 可以开始表达式：this.prop
 * ```
 *
 * ### ↔️ rightAssociative?: boolean
 * 表示操作符是否为右结合，影响相同优先级操作符的计算顺序
 * ```javascript
 * createToken("**", { rightAssociative: true })  // 2 ** 3 ** 2 = 2 ** (3 ** 2) = 512
 * // 大多数操作符是左结合的：2 + 3 + 4 = (2 + 3) + 4 = 9
 * ```
 *
 * ### 🔄 isLoop?: boolean
 * 标记关键字是否开始循环结构，用于标签解析，决定是否允许 continue 跳转
 * ```javascript
 * createKeyword("for", { isLoop })   // for 循环允许 continue
 * createKeyword("while", { isLoop }) // while 循环允许 continue
 * createKeyword("if")                // if 不是循环，不允许 continue
 * ```
 *
 * ### 📝 isAssign?: boolean
 * 标记是否为赋值操作符，影响 AST 节点类型的生成
 * ```javascript
 * createToken("=", { isAssign })   // 简单赋值：a = b
 * createToken("+=", { isAssign })  // 复合赋值：a += b
 * createToken("*=", { isAssign })  // 复合赋值：a *= b
 * ```
 *
 * ### ⬅️ prefix?: boolean
 * 表示是否可以作为前缀一元操作符
 * ```javascript
 * createToken("!", { prefix })      // !true
 * createToken("~", { prefix })      // ~flag
 * createToken("++", { prefix })     // ++counter
 * createKeyword("typeof", { prefix }) // typeof obj
 * ```
 *
 * ### ➡️ postfix?: boolean
 * 表示是否可以作为后缀一元操作符
 * ```javascript
 * createToken("++", { postfix })    // counter++
 * createToken("--", { postfix })    // counter--
 * ```
 *
 * ### 🔢 binop?: number | null
 * 二元操作符的优先级（数字越大优先级越高）
 * ```javascript
 * createBinop("+", 9)   // 加法优先级 9
 * createBinop("*", 10)  // 乘法优先级 10，比加法高
 * createBinop("**", 11) // 指数优先级 11，最高
 * ```
 *
 * ## 属性查找函数
 *
 * 这些属性通过并行数组被高效查找：
 * ```javascript
 * // 检查是否可以开始表达式
 * tokenCanStartExpression(token)     // 查找 tokenStartsExprs[token]
 *
 * // 检查操作符优先级
 * tokenOperatorPrecedence(token)     // 查找 tokenBinops[token]
 *
 * // 检查是否在表达式前
 * tokenComesBeforeExpression(token)  // 查找 tokenBeforeExprs[token]
 * ```
 *
 * @param name - Token 的名称标识符
 * @param options - Token 的语法属性配置（TokenOptions 类型）
 * @returns 唯一的数字 TokenType 标识符
 *
 * @example
 * ```javascript
 * // 创建左括号 token
 * const bracketL = createToken("[", { beforeExpr: true, startsExpr: true });
 *
 * // 创建二元操作符 token
 * const plusMin = createToken("+/-", { beforeExpr: true, binop: 9, prefix: true });
 *
 * // 后续高效查找
 * if (tokenCanStartExpression(bracketL)) { // O(1) 查找
 *   // 解析表达式
 * }
 * ```
 */
function createToken(name: string, options: TokenOptions = {}): TokenType {
  ++tokenTypeCounter;
  tokenLabels.push(name);
  tokenBinops.push(options.binop ?? -1);
  tokenBeforeExprs.push(options.beforeExpr ?? false);
  tokenStartsExprs.push(options.startsExpr ?? false);
  tokenPrefixes.push(options.prefix ?? false);
  tokenTypes.push(new ExportedTokenType(name, options));

  return tokenTypeCounter;
}

/**
 * 创建关键字类型 Token 的工厂函数
 * Factory function for creating keyword-like token types
 *
 * 这个函数专门用于创建 JavaScript/TypeScript 中的关键字类型 token，
 * 与普通的 createToken 函数相比，它具有以下特殊功能：
 *
 * 🎯 主要作用：
 * 1. 创建关键字类型的 token（如 if, for, class, function 等）
 * 2. 将关键字注册到 keywords Map 中，提供 O(1) 查找性能
 * 3. 处理向后兼容性，确保与 Babel 7 的 API 兼容
 *
 * 🔍 执行流程：
 * 1. 递增全局 token 计数器
 * 2. 【关键】将关键字注册到 keywords 映射表中
 * 3. 添加到各个属性数组中（标签、二元操作符、表达式标记等）
 * 4. 创建导出类型时使用固定标签 "name"（为了 Babel 7 兼容性）
 *
 * 🆚 与 createToken 的区别：
 * - createToken: 用于普通符号、操作符，不注册关键字
 * - createKeywordLike: 专用于关键字，会注册到 keywords Map，导出标签固定为 "name"
 *
 * 🎯 使用场景：
 * - 保留关键字：if, else, for, while, function, class 等
 * - 上下文关键字：async, await, yield, static 等
 * - 类型关键字：interface, type, declare 等（TypeScript）
 *
 * 💡 设计优势：
 * - 性能优化：通过 keywords Map 提供 O(1) 关键字查找
 * - 语义区分：将关键字与普通标识符明确区分
 * - 兼容性保证：确保与 Babel 7 API 的向后兼容性
 * - 统一管理：所有关键字通过此函数统一创建和管理
 *
 * @param name - 关键字名称（如 "if", "class", "function"）
 * @param options - token 配置选项，包含以下属性：
 *
 * 🔧 **options 属性详解**：
 *
 * • **startsExpr?: boolean** - 表达式开始标记（最常用）
 *   - 标记该 token 是否可以作为表达式的开始
 *   - 用于 yield 表达式的参数解析，决定是否可以作为子表达式
 *   - 示例：`async function() {}`, `await promise`, `class MyClass {}`
 *   - 几乎所有关键字都设置为 true
 *
 * • **beforeExpr?: boolean** - 表达式前置标记
 *   - 标记该 token 前面是否可以有表达式
 *   - 主要用于区分 JSX 标签 `<` 和二元比较操作符 `<`
 *   - 示例：`obj in array`, `obj instanceof Class`
 *
 * • **binop?: number | null** - 二元操作符优先级
 *   - 定义二元操作符的优先级（数字越大优先级越高）
 *   - 优先级表：1(||) < 2(&&) < 3(|) < 4(^) < 5(&) < 6(==) < 7(<,in,instanceof) < 8(<<) < 9(+,-) < 10(*,/,%) < 11(**)
 *   - 示例：`_in: createKeyword("in", { beforeExpr, binop: 7 })`
 *
 * • **prefix?: boolean** - 前缀操作符标记
 *   - 标记该 token 是否可以作为前缀操作符使用
 *   - 示例：`+number`, `-number`, `++variable`
 *
 * • **postfix?: boolean** - 后缀操作符标记
 *   - 标记该 token 是否可以作为后缀操作符使用
 *   - 示例：`variable++`, `variable--`
 *
 * • **rightAssociative?: boolean** - 右结合性
 *   - 标记操作符是否为右结合（默认为左结合）
 *   - 示例：`2 ** 3 ** 2` = `2 ** (3 ** 2)` = `512` (右结合)
 *
 * • **isLoop?: boolean** - 循环关键字标记
 *   - 标记该关键字是否开始一个循环结构
 *   - 用于解析标签时决定是否允许 `continue` 跳转
 *   - 示例：`for`, `while`, `do`
 *
 * • **isAssign?: boolean** - 赋值操作符标记
 *   - 标记该 token 是否为赋值操作符
 *   - 用于解析赋值表达式和模式匹配
 *   - 示例：`=`, `+=`, `*=`
 *
 * • **keyword?: string** - 关键字字符串
 *   - 指定实际的关键字字符串（通常与 name 参数相同）
 *   - 用于向后兼容和特殊情况处理
 *
 * 📝 **常见使用模式**：
 * ```typescript
 * // 大多数关键字只设置 startsExpr
 * _async: createKeywordLike("async", { startsExpr })
 * _class: createKeywordLike("class", { startsExpr })
 *
 * // 少数关键字同时作为二元操作符
 * _in: createKeyword("in", { beforeExpr, binop: 7 })
 * _instanceof: createKeyword("instanceof", { beforeExpr, binop: 7 })
 * ```
 *
 * @returns 返回唯一的 token 类型 ID
 */
function createKeywordLike(
  name: string,
  options: TokenOptions = {},
): TokenType {
  ++tokenTypeCounter;
  keywords.set(name, tokenTypeCounter);
  tokenLabels.push(name);
  tokenBinops.push(options.binop ?? -1);
  tokenBeforeExprs.push(options.beforeExpr ?? false);
  tokenStartsExprs.push(options.startsExpr ?? false);
  tokenPrefixes.push(options.prefix ?? false);
  // In the exported token type, we set the label as "name" for backward compatibility with Babel 7
  tokenTypes.push(new ExportedTokenType("name", options));

  return tokenTypeCounter;
}

// For performance the token type helpers depend on the following declarations order.
// When adding new token types, please also check if the token helpers need update.
// 为了性能，token 类型辅助函数依赖于以下声明顺序。
// 添加新的 token 类型时，请检查 token 辅助函数是否需要更新。

export type InternalTokenTypes = typeof tt;

/**
 * Token Types (tt) - Babel 解析器中的词法单元类型注册表
 *
 * 这个对象是 Babel 词法分析器的核心数据结构，定义了 JavaScript/TypeScript 中所有可能的语法元素类型。
 * 每个属性代表一种特定的语法单元（token），用于在词法分析和语法分析过程中进行高效的类型识别和比较。
 *
 * ## 核心设计原理
 *
 * ### 数字化标识符
 * - 每个 token 类型实际上是一个唯一的数字 ID（TokenType = number）
 * - 数字比较比字符串比较更高效，提升解析性能
 * - 通过 createToken() 函数自动分配递增的数字 ID
 *
 * ### 语法元数据
 * 每个 token 类型都包含重要的语法属性：
 * - `beforeExpr`: 此 token 前是否可以有表达式
 * - `startsExpr`: 此 token 是否可以开始表达式
 * - `binop`: 二元操作符的优先级（数字越大优先级越高）
 * - `prefix/postfix`: 是否可作为前缀/后缀一元操作符
 * - `isAssign`: 是否为赋值操作符
 * - `isLoop`: 是否为循环关键字
 *
 * ## 主要分类
 *
 * ### 标点符号 (Punctuation)
 * - 括号类：`bracketL` ([), `bracketR` (]), `parenL` ((), `parenR` ())
 * - 花括号：`braceL` ({), `braceR` (})
 * - 其他：`comma` (,), `semi` (;), `dot` (.), `arrow` (=>) 等
 *
 * ### 操作符 (Operators)
 * - 赋值操作符：`eq` (=), `assign` (+=, -=, 等)
 * - 二元操作符：`plusMin` (+/-), `star` (*), `slash` (/), `exponent` (**)
 * - 逻辑操作符：`logicalAND` (&&), `logicalOR` (||), `nullishCoalescing` (??)
 * - 比较操作符：`equality` (==, !=), `lt` (<), `gt` (>) 等
 *
 * ### 关键字 (Keywords)
 * - 控制流：`_if`, `_else`, `_for`, `_while`, `_switch`, `_case`
 * - 声明：`_var`, `_let`, `_const`, `_function`, `_class`
 * - 其他：`_this`, `_super`, `_new`, `_typeof`, `_instanceof`
 *
 * ### 上下文关键字 (Contextual Keywords)
 * - ES6+：`_async`, `_await`, `_yield`, `_of`, `_from`
 * - TypeScript/Flow：`_interface`, `_type`, `_declare`, `_abstract`
 *
 * ### 字面量 (Literals)
 * - `string`: 字符串字面量
 * - `num`: 数字字面量
 * - `bigint`: BigInt 字面量
 * - `regexp`: 正则表达式字面量
 *
 * ## 使用示例
 *
 * ### 在 Tokenizer 中
 * ```javascript
 * if (currentChar === '[') {
 *   return this.finishToken(tt.bracketL);
 * }
 * ```
 *
 * ### 在 Parser 中
 * ```javascript
 * if (this.match(tt.bracketL)) {
 *   return this.parseArrayLiteral();
 * }
 * if (this.match(tt._if)) {
 *   return this.parseIfStatement();
 * }
 * ```
 *
 * ### 类型检查
 * ```javascript
 * if (tokenIsKeyword(currentToken)) {
 *   // 处理关键字
 * }
 * if (tokenIsOperator(currentToken)) {
 *   // 处理操作符
 * }
 * ```
 *
 * ## 性能优化
 *
 * - 使用数字 ID 而非字符串进行快速比较
 * - 通过数组索引快速访问 token 属性
 * - 范围检查优化（如 `token >= tt._in && token <= tt._while`）
 *
 * ## 扩展性
 *
 * - 支持实验性语法特性（通过插件）
 * - 向后兼容性考虑（Babel 8 breaking changes 标记）
 * - 模块化设计，便于添加新的 token 类型
 *
 * 这个设计使得 Babel 能够高效、准确地进行词法分析，为后续的语法分析提供结构化的 token 流。
 */
export const tt = {
  // Punctuation token types.
  bracketL: createToken("[", { beforeExpr, startsExpr }),
  // TODO: Remove this in Babel 8
  bracketHashL: createToken("#[", { beforeExpr, startsExpr }),
  // TODO: Remove this in Babel 8
  bracketBarL: createToken("[|", { beforeExpr, startsExpr }),
  bracketR: createToken("]"),
  // TODO: Remove this in Babel 8
  bracketBarR: createToken("|]"),
  braceL: createToken("{", { beforeExpr, startsExpr }),
  // TODO: Remove this in Babel 8
  braceBarL: createToken("{|", { beforeExpr, startsExpr }),
  // TODO: Remove this in Babel 8
  braceHashL: createToken("#{", { beforeExpr, startsExpr }),
  braceR: createToken("}"),
  braceBarR: createToken("|}"),
  parenL: createToken("(", { beforeExpr, startsExpr }),
  parenR: createToken(")"),
  comma: createToken(",", { beforeExpr }),
  semi: createToken(";", { beforeExpr }),
  colon: createToken(":", { beforeExpr }),
  doubleColon: createToken("::", { beforeExpr }),
  dot: createToken("."),
  question: createToken("?", { beforeExpr }),
  questionDot: createToken("?."),
  arrow: createToken("=>", { beforeExpr }),
  template: createToken("template"),
  ellipsis: createToken("...", { beforeExpr }),
  backQuote: createToken("`", { startsExpr }),
  dollarBraceL: createToken("${", { beforeExpr, startsExpr }),
  // start: isTemplate
  templateTail: createToken("...`", { startsExpr }),
  templateNonTail: createToken("...${", { beforeExpr, startsExpr }),
  // end: isTemplate
  at: createToken("@"),
  hash: createToken("#", { startsExpr }),

  // Special hashbang token.
  interpreterDirective: createToken("#!..."),

  // Operators. These carry several kinds of properties to help the
  // parser use them properly (the presence of these properties is
  // what categorizes them as operators).
  //
  // `binop`, when present, specifies that this operator is a binary
  // operator, and will refer to its precedence.
  //
  // `prefix` and `postfix` mark the operator as a prefix or postfix
  // unary operator.
  //
  // `isAssign` marks all of `=`, `+=`, `-=` etcetera, which act as
  // binary operators with a very low precedence, that should result
  // in AssignmentExpression nodes.
  // 运算符。它们带有多种属性，以帮助
  // 解析器正确使用它们（这些属性的存在
  // 正是它们被归类为运算符的原因）。
  //
  // `binop` 表示该运算符为二元运算符，
  // 并将参考其优先级。
  //
  // `prefix` 和 `postfix` 将运算符标记为前缀或后缀
  // 一元运算符。
  //
  // `isAssign` 标记所有 `=`、`+=`、`-=` 等，这些运算符充当
  // 优先级非常低的二元运算符，因此应该
  // 生成 AssignmentExpression 节点。

  // start: isAssign
  eq: createToken("=", { beforeExpr, isAssign }),
  assign: createToken("_=", { beforeExpr, isAssign }),
  slashAssign: createToken("_=", { beforeExpr, isAssign }),
  // These are only needed to support % and ^ as a Hack-pipe topic token.
  // When the proposal settles on a token, the others can be merged with
  // tt.assign.
  // 这些仅用于支持 % 和 ^ 作为 Hack-pipe 主题令牌。
  // 当提案确定一个令牌时，其他令牌可以与
  // tt.assign.
  xorAssign: createToken("_=", { beforeExpr, isAssign }),
  moduloAssign: createToken("_=", { beforeExpr, isAssign }),
  // end: isAssign

  incDec: createToken("++/--", { prefix, postfix, startsExpr }),
  bang: createToken("!", { beforeExpr, prefix, startsExpr }),
  tilde: createToken("~", { beforeExpr, prefix, startsExpr }),

  // More possible topic tokens.
  // When the proposal settles on a token, at least one of these may be removed.
  // 更多可能的主题标记。
  // 当提案确定一个标记时，至少其中一个可能会被删除。
  doubleCaret: createToken("^^", { startsExpr }),
  doubleAt: createToken("@@", { startsExpr }),

  // start: isBinop
  pipeline: createBinop("|>", 0),
  nullishCoalescing: createBinop("??", 1),
  logicalOR: createBinop("||", 1),
  logicalAND: createBinop("&&", 2),
  bitwiseOR: createBinop("|", 3),
  bitwiseXOR: createBinop("^", 4),
  bitwiseAND: createBinop("&", 5),
  equality: createBinop("==/!=/===/!==", 6),
  lt: createBinop("</>/<=/>=", 7),
  gt: createBinop("</>/<=/>=", 7),
  relational: createBinop("</>/<=/>=", 7),
  bitShift: createBinop("<</>>/>>>", 8),
  bitShiftL: createBinop("<</>>/>>>", 8),
  bitShiftR: createBinop("<</>>/>>>", 8),
  plusMin: createToken("+/-", { beforeExpr, binop: 9, prefix, startsExpr }),
  // startsExpr: required by v8intrinsic plugin
  modulo: createToken("%", { binop: 10, startsExpr }),
  // unset `beforeExpr` as it can be `function *`
  star: createToken("*", { binop: 10 }),
  slash: createBinop("/", 10),
  exponent: createToken("**", {
    beforeExpr,
    binop: 11,
    rightAssociative: true,
  }),

  // Keywords
  // Don't forget to update packages/babel-helper-validator-identifier/src/keyword.js
  // when new keywords are added
  // start: isLiteralPropertyName
  // start: isKeyword
  _in: createKeyword("in", { beforeExpr, binop: 7 }),
  _instanceof: createKeyword("instanceof", { beforeExpr, binop: 7 }),
  // end: isBinop
  _break: createKeyword("break"),
  _case: createKeyword("case", { beforeExpr }),
  _catch: createKeyword("catch"),
  _continue: createKeyword("continue"),
  _debugger: createKeyword("debugger"),
  _default: createKeyword("default", { beforeExpr }),
  _else: createKeyword("else", { beforeExpr }),
  _finally: createKeyword("finally"),
  _function: createKeyword("function", { startsExpr }),
  _if: createKeyword("if"),
  _return: createKeyword("return", { beforeExpr }),
  _switch: createKeyword("switch"),
  _throw: createKeyword("throw", { beforeExpr, prefix, startsExpr }),
  _try: createKeyword("try"),
  _var: createKeyword("var"),
  _const: createKeyword("const"),
  _with: createKeyword("with"),
  _new: createKeyword("new", { beforeExpr, startsExpr }),
  _this: createKeyword("this", { startsExpr }),
  _super: createKeyword("super", { startsExpr }),
  _class: createKeyword("class", { startsExpr }),
  _extends: createKeyword("extends", { beforeExpr }),
  _export: createKeyword("export"),
  _import: createKeyword("import", { startsExpr }),
  _null: createKeyword("null", { startsExpr }),
  _true: createKeyword("true", { startsExpr }),
  _false: createKeyword("false", { startsExpr }),
  _typeof: createKeyword("typeof", { beforeExpr, prefix, startsExpr }),
  _void: createKeyword("void", { beforeExpr, prefix, startsExpr }),
  _delete: createKeyword("delete", { beforeExpr, prefix, startsExpr }),
  // start: isLoop
  _do: createKeyword("do", { isLoop, beforeExpr }),
  _for: createKeyword("for", { isLoop }),
  _while: createKeyword("while", { isLoop }),
  // end: isLoop
  // end: isKeyword

  // Primary literals
  // start: isIdentifier
  _as: createKeywordLike("as", { startsExpr }),
  _assert: createKeywordLike("assert", { startsExpr }),
  _async: createKeywordLike("async", { startsExpr }),
  _await: createKeywordLike("await", { startsExpr }),
  _defer: createKeywordLike("defer", { startsExpr }),
  _from: createKeywordLike("from", { startsExpr }),
  _get: createKeywordLike("get", { startsExpr }),
  _let: createKeywordLike("let", { startsExpr }),
  _meta: createKeywordLike("meta", { startsExpr }),
  _of: createKeywordLike("of", { startsExpr }),
  _sent: createKeywordLike("sent", { startsExpr }),
  _set: createKeywordLike("set", { startsExpr }),
  _source: createKeywordLike("source", { startsExpr }),
  _static: createKeywordLike("static", { startsExpr }),
  _using: createKeywordLike("using", { startsExpr }),
  _yield: createKeywordLike("yield", { startsExpr }),

  // Flow and TypeScript Keywordlike
  _asserts: createKeywordLike("asserts", { startsExpr }),
  _checks: createKeywordLike("checks", { startsExpr }),
  _exports: createKeywordLike("exports", { startsExpr }),
  _global: createKeywordLike("global", { startsExpr }),
  _implements: createKeywordLike("implements", { startsExpr }),
  _intrinsic: createKeywordLike("intrinsic", { startsExpr }),
  _infer: createKeywordLike("infer", { startsExpr }),
  _is: createKeywordLike("is", { startsExpr }),
  _mixins: createKeywordLike("mixins", { startsExpr }),
  _proto: createKeywordLike("proto", { startsExpr }),
  _require: createKeywordLike("require", { startsExpr }),
  _satisfies: createKeywordLike("satisfies", { startsExpr }),
  // start: isTSTypeOperator
  _keyof: createKeywordLike("keyof", { startsExpr }),
  _readonly: createKeywordLike("readonly", { startsExpr }),
  _unique: createKeywordLike("unique", { startsExpr }),
  // end: isTSTypeOperator
  // start: isTSDeclarationStart
  _abstract: createKeywordLike("abstract", { startsExpr }),
  _declare: createKeywordLike("declare", { startsExpr }),
  _enum: createKeywordLike("enum", { startsExpr }),
  _module: createKeywordLike("module", { startsExpr }),
  _namespace: createKeywordLike("namespace", { startsExpr }),
  // start: isFlowInterfaceOrTypeOrOpaque
  _interface: createKeywordLike("interface", { startsExpr }),
  _type: createKeywordLike("type", { startsExpr }),
  // end: isTSDeclarationStart
  _opaque: createKeywordLike("opaque", { startsExpr }),
  // end: isFlowInterfaceOrTypeOrOpaque
  name: createToken("name", { startsExpr }),

  // placeholder plugin
  placeholder: createToken("%%", { startsExpr }),
  // end: isIdentifier

  string: createToken("string", { startsExpr }),
  num: createToken("num", { startsExpr }),
  bigint: createToken("bigint", { startsExpr }),
  // TODO: Remove this in Babel 8
  decimal: createToken("decimal", { startsExpr }),
  // end: isLiteralPropertyName
  regexp: createToken("regexp", { startsExpr }),
  privateName: createToken("#name", { startsExpr }),
  eof: createToken("eof"),

  // jsx plugin
  jsxName: createToken("jsxName"),
  jsxText: createToken("jsxText", { beforeExpr }),
  jsxTagStart: createToken("jsxTagStart", { startsExpr }),
  jsxTagEnd: createToken("jsxTagEnd"),
} as const;

export function tokenIsIdentifier(token: TokenType): boolean {
  return token >= tt._as && token <= tt.placeholder;
}

export function tokenKeywordOrIdentifierIsKeyword(token: TokenType): boolean {
  // we can remove the token >= tt._in check when we
  // know a token is either keyword or identifier
  return token <= tt._while;
}

export function tokenIsKeywordOrIdentifier(token: TokenType): boolean {
  return token >= tt._in && token <= tt.placeholder;
}

export function tokenIsLiteralPropertyName(token: TokenType): boolean {
  return token >= tt._in && token <= tt.decimal;
}

export function tokenComesBeforeExpression(token: TokenType): boolean {
  return tokenBeforeExprs[token];
}

export function tokenCanStartExpression(token: TokenType): boolean {
  return tokenStartsExprs[token];
}

export function tokenIsAssignment(token: TokenType): boolean {
  return token >= tt.eq && token <= tt.moduloAssign;
}

export function tokenIsFlowInterfaceOrTypeOrOpaque(token: TokenType): boolean {
  return token >= tt._interface && token <= tt._opaque;
}

export function tokenIsLoop(token: TokenType): boolean {
  return token >= tt._do && token <= tt._while;
}

export function tokenIsKeyword(token: TokenType): boolean {
  return token >= tt._in && token <= tt._while;
}

export function tokenIsOperator(token: TokenType): boolean {
  return token >= tt.pipeline && token <= tt._instanceof;
}

export function tokenIsPostfix(token: TokenType): boolean {
  return token === tt.incDec;
}

export function tokenIsPrefix(token: TokenType): boolean {
  return tokenPrefixes[token];
}

export function tokenIsTSTypeOperator(token: TokenType): boolean {
  return token >= tt._keyof && token <= tt._unique;
}

export function tokenIsTSDeclarationStart(token: TokenType): boolean {
  return token >= tt._abstract && token <= tt._type;
}

export function tokenLabelName(token: TokenType): string {
  return tokenLabels[token];
}

export function tokenOperatorPrecedence(token: TokenType): number {
  return tokenBinops[token];
}

export function tokenIsBinaryOperator(token: TokenType): boolean {
  return tokenBinops[token] !== -1;
}

export function tokenIsRightAssociative(token: TokenType): boolean {
  return token === tt.exponent;
}

export function tokenIsTemplate(token: TokenType): boolean {
  return token >= tt.templateTail && token <= tt.templateNonTail;
}

export function getExportedToken(token: TokenType): ExportedTokenType {
  return tokenTypes[token];
}

export function isTokenType(obj: any): boolean {
  return typeof obj === "number";
}

if (!process.env.BABEL_8_BREAKING) {
  tokenTypes[tt.braceR].updateContext = context => {
    context.pop();
  };

  tokenTypes[tt.braceL].updateContext =
    tokenTypes[tt.braceHashL].updateContext =
    tokenTypes[tt.dollarBraceL].updateContext =
      context => {
        context.push(tc.brace);
      };

  tokenTypes[tt.backQuote].updateContext = context => {
    if (context[context.length - 1] === tc.template) {
      context.pop();
    } else {
      context.push(tc.template);
    }
  };

  tokenTypes[tt.jsxTagStart].updateContext = context => {
    context.push(tc.j_expr, tc.j_oTag);
  };
}
