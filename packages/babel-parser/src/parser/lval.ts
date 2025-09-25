/**
 * LVal（Left-hand side Value）解析器文件
 *
 * 这个文件是 Babel 解析器中专门处理左值（LVal）解析的核心模块。
 * 左值是指可以出现在赋值表达式左侧的值，包括变量、解构模式、成员表达式等。
 *
 * ## 主要功能
 *
 * ### 1. 赋值模式转换
 * - 将表达式转换为赋值模式（如将对象表达式转换为对象解构模式）
 * - 处理数组解构、对象解构、剩余参数等复杂模式
 * - 验证赋值目标的合法性
 *
 * ### 2. 绑定模式解析
 * - 解析函数参数、变量声明中的绑定模式
 * - 处理默认参数、剩余参数、解构参数
 * - 支持 TypeScript 参数属性和装饰器
 *
 * ### 3. 模式验证
 * - 检查左值的合法性（如不能对字面量赋值）
 * - 验证严格模式下的标识符限制
 * - 处理作用域绑定和名称冲突检查
 *
 * ### 4. 语法规范支持
 * - 支持 ECMAScript 解构赋值规范
 * - 处理剩余元素的位置限制
 * - 支持可选链赋值等现代语法特性
 *
 * ## 在解析流程中的作用
 *
 * LValParser 作为解析器的重要组成部分，处理所有涉及赋值和绑定的语法结构：
 * - 变量声明：`const [a, b] = array`
 * - 函数参数：`function fn({x, y = 1}) {}`
 * - 赋值表达式：`[a, b] = [1, 2]`
 * - 解构赋值：`{x: newX} = obj`
 * - 剩余参数：`function fn(...args) {}`
 */

import * as charCodes from "charcodes";
import { tt, type TokenType } from "../tokenizer/types.ts";
import type {
  AssignmentPattern,
  TSParameterProperty,
  Decorator,
  Expression,
  Identifier,
  Node,
  Pattern,
  RestElement,
  SpreadElement,
  ObjectOrClassMember,
  ClassMember,
  ObjectMember,
  TsNamedTypeElementBase,
  PrivateName,
  ObjectExpression,
  ObjectPattern,
  ArrayPattern,
  AssignmentProperty,
  Assignable,
  VoidPattern,
} from "../types.ts";
import type { Position } from "../util/location.ts";
import {
  isStrictBindOnlyReservedWord,
  isStrictBindReservedWord,
} from "../util/identifier.ts";
import { NodeUtils, type Undone } from "./node.ts";
import { BindingFlag } from "../util/scopeflags.ts";
import type { ExpressionErrors } from "./util.ts";
import { Errors, type LValAncestor } from "../parse-error.ts";
import type Parser from "./index.ts";

/**
 * 递归解包括号表达式，获取真正的表达式内容
 * 例如：((a)) -> a
 *
 * @param node 要解包的节点
 * @returns 解包后的表达式节点
 */
const unwrapParenthesizedExpression = (node: Node): Node => {
  return node.type === "ParenthesizedExpression"
    ? unwrapParenthesizedExpression(node.expression)
    : node;
};

/**
 * 绑定列表解析标志枚举
 * 用于控制不同上下文中绑定列表的解析行为
 */
export const enum ParseBindingListFlags {
  ALLOW_EMPTY = 1 << 0, // 允许空元素（如数组解构中的 [,, a]）
  IS_FUNCTION_PARAMS = 1 << 1, // 是函数参数列表
  IS_CONSTRUCTOR_PARAMS = 1 << 2, // 是构造函数参数列表
}

/**
 * LValParser 抽象类
 *
 * 继承自 NodeUtils，专门处理左值（LVal）相关的解析逻辑。
 * 左值是指可以出现在赋值表达式左侧的值，如变量、属性访问、解构模式等。
 *
 * ## 核心职责
 *
 * ### 1. 表达式到模式的转换
 * - toAssignable(): 将表达式转换为可赋值的模式
 * - toAssignableList(): 批量转换表达式列表
 * - isAssignable(): 检查表达式是否可赋值
 *
 * ### 2. 绑定模式解析
 * - parseBindingAtom(): 解析基础绑定原子
 * - parseBindingList(): 解析绑定列表
 * - parseMaybeDefault(): 解析可能带默认值的绑定
 *
 * ### 3. 模式验证
 * - checkLVal(): 验证左值的合法性
 * - checkIdentifier(): 检查标识符的合法性
 * - isValidLVal(): 判断节点类型是否为有效左值
 *
 * ### 4. 特殊语法处理
 * - parseSpread(): 解析展开语法
 * - parseRestBinding(): 解析剩余绑定
 * - checkToRestConversion(): 检查到剩余参数的转换
 */
export default abstract class LValParser extends NodeUtils {
  // Forward-declaration: defined in expression.js
  // 前向声明：在 expression.js 中定义
  abstract parseIdentifier(liberal?: boolean): Identifier;
  abstract parseMaybeAssign(
    refExpressionErrors?: ExpressionErrors | null,
    afterLeftParse?: Function,
  ): Expression;

  abstract parseMaybeAssignAllowIn(
    refExpressionErrors?: ExpressionErrors | null,
    afterLeftParse?: Function,
  ): Expression;

  abstract parseObjectLike<T extends ObjectPattern | ObjectExpression>(
    close: TokenType,
    isPattern: boolean,
    isRecord?: boolean,
    refExpressionErrors?: ExpressionErrors,
  ): T;
  abstract parseObjPropValue(
    prop: any,
    startLoc: Position | null,
    isGenerator: boolean,
    isAsync: boolean,
    isPattern: boolean,
    isAccessor: boolean,
    refExpressionErrors?: ExpressionErrors | null,
  ): void;
  abstract parsePropertyName(
    prop: ObjectOrClassMember | ClassMember | TsNamedTypeElementBase,
  ): void;
  abstract parsePrivateName(): PrivateName;
  // Forward-declaration: defined in statement.js
  // 前向声明：在 statement.js 中定义
  abstract parseDecorator(): Decorator;

  /**
   * Convert existing expression atom to assignable pattern
   * if possible. Also checks invalid destructuring targets:
   *
   * - Parenthesized Destructuring patterns
   * - RestElement is not the last element
   * - Missing `=` in assignment pattern
   *
   * NOTE: There is a corresponding "isAssignable" method.
   * When this one is updated, please check if also that one needs to be updated.
   *
   * 将现有表达式原子转换为可赋值模式
   * 如果可能。同时检查无效的解构目标：
   *
   * - 带括号的解构模式
   * - RestElement 不是最后一个元素
   * - 赋值模式中缺少 `=`
   *
   * 注意：有一个对应的“isAssignable”方法。
   * 更新此方法时，请检查是否也需要更新那个方法。
   *
   * @param node The expression atom
   * @param isLHS Whether we are parsing a LeftHandSideExpression.
   *              If isLHS is `true`, the following cases are allowed: `[(a)] = [0]`, `[(a.b)] = [0]`
   *              If isLHS is `false`, we are in an arrow function parameters list.
   */
  toAssignable(node: Node, isLHS: boolean = false): asserts node is Assignable {
    let parenthesized = undefined;
    if (node.type === "ParenthesizedExpression" || node.extra?.parenthesized) {
      parenthesized = unwrapParenthesizedExpression(node);
      if (isLHS) {
        // an LHS can be reinterpreted to a binding pattern but not vice versa.
        // therefore a parenthesized identifier is ambiguous until we are sure it is an assignment expression
        // i.e. `([(a) = []] = []) => {}`
        // see also `recordArrowParameterBindingError` signature in packages/babel-parser/src/util/expression-scope.js
        // LHS 可以重新解释为绑定模式，但反之则不行。
        // 因此，括号内的标识符具有二义性，除非我们确定它是一个赋值表达式。
        // ✅ 这个可以重新解释：
        // 先当作表达式：{a, b}（对象）
        // 后来发现是赋值：{a, b} = obj（解构）
        // {a, b} = obj;
        // // ❌ 但这个不能反过来：
        // // 如果已经确定是绑定模式（比如函数参数）
        // function fn({a, b}) {
        //   // 这里的 {a, b} 已经确定是参数解构
        //   // 不能再"反悔"说它是个普通对象
        // }
        // 例如，`([(a) = []] = []) => {}`
        // 另请参阅 packages/babel-parser/src/util/expression-scope.js 中的 `recordArrowParameterBindingError` 签名
        if (parenthesized.type === "Identifier") {
          this.expressionScope.recordArrowParameterBindingError(
            Errors.InvalidParenthesizedAssignment,
            node,
          );
        } else if (
          parenthesized.type !== "MemberExpression" &&
          !this.isOptionalMemberExpression(parenthesized)
        ) {
          // A parenthesized member expression can be in LHS but not in pattern.
          // If the LHS is later interpreted as a pattern, `checkLVal` will throw for member expression binding
          // i.e. `([(a.b) = []] = []) => {}`
          // 带括号的成员表达式可以位于 LHS 中，但不能位于模式中。
          // 如果 LHS 随后被解释为模式，则 `checkLVal` 将因成员表达式绑定而抛出。
          // 即 `([(a.b) = []] = []) => {}`
          this.raise(Errors.InvalidParenthesizedAssignment, node);
        }
      } else {
        this.raise(Errors.InvalidParenthesizedAssignment, node);
      }
    }

    switch (node.type) {
      case "Identifier":
      case "ObjectPattern":
      case "ArrayPattern":
      case "AssignmentPattern":
      case "RestElement":
      case "VoidPattern":
        break;

      case "ObjectExpression":
        this.castNodeTo(node, "ObjectPattern");
        for (
          let i = 0, length = node.properties.length, last = length - 1;
          i < length;
          i++
        ) {
          const prop = node.properties[i];
          const isLast = i === last;
          this.toAssignableObjectExpressionProp(prop, isLast, isLHS);

          if (
            isLast &&
            (prop as Node).type === "RestElement" &&
            node.extra?.trailingCommaLoc
          ) {
            this.raise(Errors.RestTrailingComma, node.extra.trailingCommaLoc);
          }
        }
        break;

      case "ObjectProperty": {
        const { key, value } = node;
        if (this.isPrivateName(key)) {
          this.classScope.usePrivateName(
            this.getPrivateNameSV(key),
            key.loc.start,
          );
        }
        this.toAssignable(value, isLHS);
        break;
      }

      case "SpreadElement": {
        throw new Error(
          "Internal @babel/parser error (this is a bug, please report it)." +
            " SpreadElement should be converted by .toAssignable's caller.",
        );
      }

      case "ArrayExpression":
        this.castNodeTo(node, "ArrayPattern");
        this.toAssignableList(
          node.elements,
          node.extra?.trailingCommaLoc,
          isLHS,
        );
        break;

      case "AssignmentExpression":
        if (node.operator !== "=") {
          this.raise(Errors.MissingEqInAssignment, node.left.loc.end);
        }

        this.castNodeTo(node, "AssignmentPattern");
        delete node.operator;
        if (node.left.type === "VoidPattern") {
          this.raise(Errors.VoidPatternInitializer, node.left);
        }
        this.toAssignable(node.left, isLHS);
        break;

      case "ParenthesizedExpression":
        /*::invariant (parenthesized !== undefined) */
        this.toAssignable(parenthesized, isLHS);
        break;

      default:
      // We don't know how to deal with this node. It will
      // be reported by a later call to checkLVal
    }
  }

  /**
   * 将对象表达式的属性转换为可赋值的属性
   * 处理对象解构中的各种属性类型：普通属性、方法、展开属性等
   *
   * @param prop 要转换的属性节点
   * @param isLast 是否为最后一个属性
   * @param isLHS 是否在左手侧表达式中
   */
  toAssignableObjectExpressionProp(
    prop: Node,
    isLast: boolean,
    isLHS: boolean,
  ) {
    if (prop.type === "ObjectMethod") {
      this.raise(
        prop.kind === "get" || prop.kind === "set"
          ? Errors.PatternHasAccessor
          : Errors.PatternHasMethod,
        prop.key,
      );
    } else if (prop.type === "SpreadElement") {
      this.castNodeTo(prop, "RestElement");
      const arg = prop.argument;
      this.checkToRestConversion(arg, /* allowPattern */ false);
      this.toAssignable(arg, isLHS);

      if (!isLast) {
        this.raise(Errors.RestTrailingComma, prop);
      }
    } else {
      this.toAssignable(prop, isLHS);
    }
  }

  // Convert list of expression atoms to binding list.
  // 将表达式原子列表转换为绑定列表

  /**
   * 将表达式列表转换为可赋值的列表
   * 主要用于数组解构模式的处理
   *
   * @param exprList 表达式列表
   * @param trailingCommaLoc 尾随逗号的位置（用于错误报告）
   * @param isLHS 是否在左手侧表达式中
   */
  toAssignableList(
    exprList: (
      | Expression
      | SpreadElement
      | RestElement
      | VoidPattern
      | AssignmentPattern
      | null
    )[],
    trailingCommaLoc: Position | undefined | null,
    isLHS: boolean,
  ): void {
    const end = exprList.length - 1;

    for (let i = 0; i <= end; i++) {
      const elt = exprList[i];
      if (!elt) continue;

      this.toAssignableListItem(exprList, i, isLHS);

      if (elt.type === "RestElement") {
        if (i < end) {
          this.raise(Errors.RestTrailingComma, elt);
        } else if (trailingCommaLoc) {
          this.raise(Errors.RestTrailingComma, trailingCommaLoc);
        }
      }
    }
  }

  /**
   * 转换列表中的单个项目为可赋值项目
   * 处理展开元素到剩余元素的转换
   *
   * @param exprList 表达式列表
   * @param index 当前项目的索引
   * @param isLHS 是否在左手侧表达式中
   */
  toAssignableListItem(
    exprList: (
      | Expression
      | SpreadElement
      | RestElement
      | VoidPattern
      | AssignmentPattern
    )[],
    index: number,
    isLHS: boolean,
  ): void {
    const node = exprList[index];
    if (node.type === "SpreadElement") {
      this.castNodeTo(node, "RestElement");
      const arg = node.argument;
      this.checkToRestConversion(arg, /* allowPattern */ true);
      this.toAssignable(arg, isLHS);
    } else {
      this.toAssignable(node, isLHS);
    }
  }

  /**
   * 检查节点是否可以作为赋值目标
   * 这是 toAssignable 方法的只读版本，不会修改节点
   *
   * @param node 要检查的节点
   * @param isBinding 是否在绑定上下文中（如变量声明）
   * @returns 是否可赋值
   */
  isAssignable(node: Node, isBinding?: boolean): boolean {
    switch (node.type) {
      case "Identifier":
      case "ObjectPattern":
      case "ArrayPattern":
      case "AssignmentPattern":
      case "RestElement":
      case "VoidPattern":
        return true;

      case "ObjectExpression": {
        const last = node.properties.length - 1;
        return node.properties.every((prop, i) => {
          return (
            prop.type !== "ObjectMethod" &&
            (i === last || prop.type !== "SpreadElement") &&
            this.isAssignable(prop)
          );
        });
      }

      case "ObjectProperty":
        return this.isAssignable(node.value);

      case "SpreadElement":
        return this.isAssignable(node.argument);

      case "ArrayExpression":
        return node.elements.every(
          element => element === null || this.isAssignable(element),
        );

      case "AssignmentExpression":
        return node.operator === "=";

      case "ParenthesizedExpression":
        return this.isAssignable(node.expression);

      case "MemberExpression":
      case "OptionalMemberExpression":
        return !isBinding;

      default:
        return false;
    }
  }

  // Convert list of expression atoms to a list of
  // 将表达式原子列表转换为引用列表

  /**
   * 将表达式列表转换为引用列表
   * 在某些上下文中，需要将表达式解释为引用而非绑定
   *
   * @param exprList 表达式列表
   * @param isParenthesizedExpr 是否为括号表达式
   * @returns 转换后的引用列表
   */
  toReferencedList(
    exprList:
      | ReadonlyArray<
          Expression | SpreadElement | VoidPattern | AssignmentPattern
        >
      | ReadonlyArray<
          Expression | RestElement | VoidPattern | AssignmentPattern
        >,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    isParenthesizedExpr?: boolean,
  ):
    | ReadonlyArray<
        Expression | SpreadElement | VoidPattern | AssignmentPattern
      >
    | ReadonlyArray<
        Expression | RestElement | VoidPattern | AssignmentPattern
      > {
    return exprList;
  }

  /**
   * 深度转换表达式列表为引用列表
   * 递归处理嵌套的数组表达式
   *
   * @param exprList 表达式列表
   * @param isParenthesizedExpr 是否为括号表达式
   */
  toReferencedListDeep(
    exprList:
      | ReadonlyArray<
          Expression | SpreadElement | VoidPattern | AssignmentPattern
        >
      | ReadonlyArray<
          Expression | RestElement | VoidPattern | AssignmentPattern
        >,
    isParenthesizedExpr?: boolean,
  ): void {
    this.toReferencedList(exprList, isParenthesizedExpr);

    for (const expr of exprList) {
      if (expr?.type === "ArrayExpression") {
        this.toReferencedListDeep(expr.elements);
      }
    }
  }

  // Parses spread element.
  // 解析展开元素

  /**
   * 解析展开语法 (...expression)
   * 用于数组展开、对象展开、函数调用参数展开等
   *
   * @param refExpressionErrors 表达式错误引用
   * @returns 展开元素节点
   */
  parseSpread(
    this: Parser,
    refExpressionErrors?: ExpressionErrors | null,
  ): SpreadElement {
    const node = this.startNode<SpreadElement>();
    this.next();
    node.argument = this.parseMaybeAssignAllowIn(
      refExpressionErrors,
      undefined,
    );
    return this.finishNode(node, "SpreadElement");
  }

  // https://tc39.es/ecma262/#prod-BindingRestElement
  /**
   * 解析绑定剩余元素 (...identifier)
   * 遵循 ECMAScript 规范中的 BindingRestElement 产生式
   *
   * @returns 剩余元素节点
   */
  parseRestBinding(this: Parser): RestElement {
    const node = this.startNode<RestElement>();
    this.next(); // eat `...`
    const argument = this.parseBindingAtom();
    if (argument.type === "VoidPattern") {
      this.raise(Errors.UnexpectedVoidPattern, argument);
    }
    node.argument = argument;
    return this.finishNode(node, "RestElement");
  }

  // Parses lvalue (assignable) atom.
  // 解析左值（可赋值）原子

  /**
   * 解析绑定原子 - 最基本的绑定单元
   * 可以是标识符、数组模式、对象模式或 void 模式
   *
   * @returns 模式节点
   */
  parseBindingAtom(this: Parser): Pattern {
    // https://tc39.es/ecma262/#prod-BindingPattern
    switch (this.state.type) {
      case tt.bracketL: {
        const node = this.startNode<ArrayPattern>();
        this.next();
        node.elements = this.parseBindingList(
          tt.bracketR,
          charCodes.rightSquareBracket,
          ParseBindingListFlags.ALLOW_EMPTY,
        );
        return this.finishNode(node, "ArrayPattern");
      }

      case tt.braceL:
        return this.parseObjectLike(tt.braceR, true);

      case tt._void:
        return this.parseVoidPattern(null);
    }

    // https://tc39.es/ecma262/#prod-BindingIdentifier
    return this.parseIdentifier();
  }

  // https://tc39.es/ecma262/#prod-BindingElementList
  parseBindingList(
    this: Parser,
    close: TokenType,
    closeCharCode: (typeof charCodes)[keyof typeof charCodes],
    flags: ParseBindingListFlags.ALLOW_EMPTY,
  ): Array<Pattern>;
  parseBindingList(
    this: Parser,
    close: TokenType,
    closeCharCode: (typeof charCodes)[keyof typeof charCodes],
    flags: ParseBindingListFlags.IS_FUNCTION_PARAMS,
  ): Array<Pattern | TSParameterProperty>;
  parseBindingList(
    this: Parser,
    close: TokenType,
    closeCharCode: (typeof charCodes)[keyof typeof charCodes],
    flags: ParseBindingListFlags,
  ): Array<Pattern | TSParameterProperty> {
    const allowEmpty = flags & ParseBindingListFlags.ALLOW_EMPTY;

    const elts: Array<Pattern | TSParameterProperty> = [];
    let first = true;
    while (!this.eat(close)) {
      if (first) {
        first = false;
      } else {
        this.expect(tt.comma);
      }
      if (allowEmpty && this.match(tt.comma)) {
        elts.push(null);
      } else if (this.eat(close)) {
        break;
      } else if (this.match(tt.ellipsis)) {
        let rest: Pattern = this.parseRestBinding();
        if (
          (!process.env.BABEL_8_BREAKING && this.hasPlugin("flow")) ||
          flags & ParseBindingListFlags.IS_FUNCTION_PARAMS
        ) {
          rest = this.parseFunctionParamType(rest);
        }
        elts.push(rest);
        if (!this.checkCommaAfterRest(closeCharCode)) {
          this.expect(close);
          break;
        }
      } else {
        const decorators = [];
        if (flags & ParseBindingListFlags.IS_FUNCTION_PARAMS) {
          if (this.match(tt.at) && this.hasPlugin("decorators")) {
            this.raise(
              Errors.UnsupportedParameterDecorator,
              this.state.startLoc,
            );
          }
          // invariant: hasPlugin("decorators-legacy")
          while (this.match(tt.at)) {
            decorators.push(this.parseDecorator());
          }
        }
        elts.push(this.parseBindingElement(flags, decorators));
      }
    }
    return elts;
  }

  // https://tc39.es/ecma262/#prod-BindingRestProperty
  parseBindingRestProperty(
    this: Parser,
    prop: Undone<RestElement>,
  ): RestElement {
    this.next(); // eat '...'
    if (this.hasPlugin("discardBinding") && this.match(tt._void)) {
      prop.argument = this.parseVoidPattern(null);
      this.raise(Errors.UnexpectedVoidPattern, prop.argument);
    } else {
      // Don't use parseRestBinding() as we only allow Identifier here.
      prop.argument = this.parseIdentifier();
    }
    this.checkCommaAfterRest(charCodes.rightCurlyBrace);
    return this.finishNode(prop, "RestElement");
  }

  // https://tc39.es/ecma262/#prod-BindingProperty
  parseBindingProperty(this: Parser): AssignmentProperty | RestElement {
    const { type, startLoc } = this.state;
    if (type === tt.ellipsis) {
      return this.parseBindingRestProperty(this.startNode());
    }

    const prop = this.startNode<AssignmentProperty>();
    if (type === tt.privateName) {
      this.expectPlugin("destructuringPrivate", startLoc);
      this.classScope.usePrivateName(this.state.value, startLoc);
      prop.key = this.parsePrivateName();
    } else {
      this.parsePropertyName(prop);
    }
    prop.method = false;
    return this.parseObjPropValue(
      prop,
      startLoc,
      false /* isGenerator */,
      false /* isAsync */,
      true /* isPattern */,
      false /* isAccessor */,
    );
  }

  // https://tc39.es/ecma262/#prod-BindingElement
  parseBindingElement(
    this: Parser,
    flags: ParseBindingListFlags,
    decorators: Decorator[],
  ): Pattern | TSParameterProperty {
    const left = this.parseMaybeDefault();
    if (
      (!process.env.BABEL_8_BREAKING && this.hasPlugin("flow")) ||
      flags & ParseBindingListFlags.IS_FUNCTION_PARAMS
    ) {
      this.parseFunctionParamType(left);
    }
    if (decorators.length) {
      left.decorators = decorators;
      this.resetStartLocationFromNode(left, decorators[0]);
    }
    const elt = this.parseMaybeDefault(left.loc.start, left);
    return elt;
  }

  // Used by flow/typescript plugin to add type annotations to binding elements
  // 由 Flow/TypeScript 插件使用，为绑定元素添加类型注解

  /**
   * 解析函数参数类型
   * 这个方法在基类中是空实现，由 Flow/TypeScript 插件重写
   *
   * @param param 参数模式
   * @returns 带类型注解的参数模式
   */
  parseFunctionParamType(param: Pattern): Pattern {
    return param;
  }

  // Parses assignment pattern around given atom if possible.
  // 如果可能的话，解析给定原子周围的赋值模式
  // https://tc39.es/ecma262/#prod-BindingElement

  /**
   * 解析可能带默认值的绑定模式
   * 处理如 `a = 1`、`{x} = obj` 这样的默认参数和解构赋值
   *
   * @param startLoc 开始位置
   * @param left 左侧模式（如果已解析）
   * @returns 模式或赋值模式节点
   */
  parseMaybeDefault<P extends Pattern>(
    this: Parser,
    startLoc?: Position | null,
    left?: P,
  ): P | AssignmentPattern;
  parseMaybeDefault(
    this: Parser,
    startLoc?: Position | null,
    left?: Pattern | null,
  ): Pattern {
    startLoc ??= this.state.startLoc;
    left = left ?? this.parseBindingAtom();
    if (!this.eat(tt.eq)) return left;

    const node = this.startNodeAt<AssignmentPattern>(startLoc);
    if (left.type === "VoidPattern") {
      this.raise(Errors.VoidPatternInitializer, left);
    }
    node.left = left;
    node.right = this.parseMaybeAssignAllowIn();
    return this.finishNode(node, "AssignmentPattern");
  }
  /**
   * Return information use in determining whether a Node of a given type is an LVal,
   * possibly given certain additional context information.
   *
   * Subclasser notes: This method has kind of a lot of mixed, but related,
   * responsibilities. If we can definitively determine with the information
   * provided that this either *is* or *isn't* a valid `LVal`, then the return
   * value is easy: just return `true` or `false`. However, if it is a valid
   * LVal *ancestor*, and thus its descendants must be subsequently visited to
   * continue the "investigation", then this method should return the relevant
   * child key as a `string`. In some special cases, you additionally want to
   * convey that this node should be treated as if it were parenthesized. In
   * that case, a tuple of [key: string, parenthesized: boolean] is returned.
   * The `string`-only return option is actually just a shorthand for:
   * `[key: string, parenthesized: false]`.
   *
   * @param type A Node `type` string
   * @param isUnparenthesizedInAssign
   *        Whether the node in question is unparenthesized and its parent
   *        is either an assignment pattern or an assignment expression.
   * @param binding
   *        The binding operation that is being considered for this potential
   *        LVal.
   * @returns `true` or `false` if we can immediately determine whether the node
   *          type in question can be treated as an `LVal`.
   *          A `string` key to traverse if we must check this child.
   *          A `[string, boolean]` tuple if we need to check this child and
   *          treat is as parenthesized.
   */
  isValidLVal(
    type: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    isUnparenthesizedInAssign: boolean,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    binding: BindingFlag,
  ): string | boolean | [string, boolean] {
    switch (type) {
      case "AssignmentPattern":
        return "left";
      case "RestElement":
        return "argument";
      case "ObjectProperty":
        return "value";
      case "ParenthesizedExpression":
        return "expression";
      case "ArrayPattern":
        return "elements";
      case "ObjectPattern":
        return "properties";
      case "VoidPattern":
        return true;
    }
    return false;
  }

  // Overridden by the estree plugin
  // 由 ESTree 插件重写

  /**
   * 检查表达式是否为可选成员表达式
   * 在 ESTree 插件中会被重写以支持不同的 AST 格式
   *
   * @param expression 要检查的表达式
   * @returns 是否为可选成员表达式
   */
  isOptionalMemberExpression(expression: Node): boolean {
    return expression.type === "OptionalMemberExpression";
  }

  /**
   * Verify that a target expression is an lval (something that can be assigned to).
   *
   * @param expression The expression in question to check.
   * @param ancestor
   *        The relevant ancestor to provide context information for the error
   *        if the check fails.
   * @param binding
   *        The desired binding type. If the given expression is an identifier
   *        and `binding` is not `BindingFlag.TYPE_NONE`, `checkLVal` will register binding
   *        to the parser scope See also `src/util/scopeflags.js`
   * @param checkClashes
   *        An optional string set to check if an identifier name is included.
   *        `checkLVal` will add checked identifier name to `checkClashes` It is
   *        used in tracking duplicates in function parameter lists. If it is
   *        false, `checkLVal` will skip duplicate checks
   * @param strictModeChanged
   *        Whether an identifier has been parsed in a sloppy context but should
   *        be reinterpreted as strict-mode. e.g. `(arguments) => { "use strict "}`
   * @param hasParenthesizedAncestor
   *        This is only used internally during recursive calls, and you should
   *        not have to set it yourself.
   */

  checkLVal(
    expression:
      | Expression
      | ObjectMember
      | RestElement
      | Pattern
      | TSParameterProperty,
    ancestor: LValAncestor,
    binding: BindingFlag = BindingFlag.TYPE_NONE,
    checkClashes: Set<string> | false = false,
    strictModeChanged: boolean = false,
    hasParenthesizedAncestor: boolean = false,
  ): void {
    const type = expression.type;

    // If we find here an ObjectMethod, it's because this was originally
    // an ObjectExpression which has then been converted.
    // toAssignable already reported this error with a nicer message.
    if (this.isObjectMethod(expression)) return;

    const isOptionalMemberExpression =
      this.isOptionalMemberExpression(expression);

    if (isOptionalMemberExpression || type === "MemberExpression") {
      if (isOptionalMemberExpression) {
        this.expectPlugin("optionalChainingAssign", expression.loc.start);
        if (ancestor.type !== "AssignmentExpression") {
          this.raise(Errors.InvalidLhsOptionalChaining, expression, {
            ancestor,
          });
        }
      }

      if (binding !== BindingFlag.TYPE_NONE) {
        this.raise(Errors.InvalidPropertyBindingPattern, expression);
      }
      return;
    }

    if (type === "Identifier") {
      this.checkIdentifier(expression, binding, strictModeChanged);

      const { name } = expression;

      if (checkClashes) {
        if (checkClashes.has(name)) {
          this.raise(Errors.ParamDupe, expression);
        } else {
          checkClashes.add(name);
        }
      }

      return;
    } else if (type === "VoidPattern" && ancestor.type === "CatchClause") {
      this.raise(Errors.VoidPatternCatchClauseParam, expression);
    }

    const validity = this.isValidLVal(
      type,
      !(hasParenthesizedAncestor || expression.extra?.parenthesized) &&
        ancestor.type === "AssignmentExpression",
      binding,
    );

    if (validity === true) return;
    if (validity === false) {
      const ParseErrorClass =
        binding === BindingFlag.TYPE_NONE
          ? Errors.InvalidLhs
          : Errors.InvalidLhsBinding;

      this.raise(ParseErrorClass, expression, { ancestor });
      return;
    }

    let key: string, isParenthesizedExpression: boolean;
    if (typeof validity === "string") {
      key = validity;
      isParenthesizedExpression = type === "ParenthesizedExpression";
    } else {
      [key, isParenthesizedExpression] = validity;
    }

    const nextAncestor =
      type === "ArrayPattern" || type === "ObjectPattern"
        ? ({ type } as const)
        : ancestor;

    // @ts-expect-error key may not index expression.
    const val = expression[key];
    if (Array.isArray(val)) {
      for (const child of val) {
        if (child) {
          this.checkLVal(
            child,
            nextAncestor,
            binding,
            checkClashes,
            strictModeChanged,
            isParenthesizedExpression,
          );
        }
      }
    } else if (val) {
      this.checkLVal(
        val,
        nextAncestor,
        binding,
        checkClashes,
        strictModeChanged,
        isParenthesizedExpression,
      );
    }
  }

  /**
   * 检查标识符的合法性
   * 验证严格模式下的保留字限制和绑定规则
   *
   * @param at 标识符节点
   * @param bindingType 绑定类型标志
   * @param strictModeChanged 严格模式是否发生变化
   */
  checkIdentifier(
    at: Identifier,
    bindingType: BindingFlag,
    strictModeChanged: boolean = false,
  ) {
    if (
      this.state.strict &&
      (strictModeChanged
        ? isStrictBindReservedWord(at.name, this.inModule)
        : isStrictBindOnlyReservedWord(at.name))
    ) {
      if (bindingType === BindingFlag.TYPE_NONE) {
        this.raise(Errors.StrictEvalArguments, at, { referenceName: at.name });
      } else {
        this.raise(Errors.StrictEvalArgumentsBinding, at, {
          bindingName: at.name,
        });
      }
    }

    if (bindingType & BindingFlag.FLAG_NO_LET_IN_LEXICAL && at.name === "let") {
      this.raise(Errors.LetInLexicalBinding, at);
    }

    if (!(bindingType & BindingFlag.TYPE_NONE)) {
      this.declareNameFromIdentifier(at, bindingType);
    }
  }

  /**
   * 从标识符声明名称到作用域
   * 将标识符注册到当前作用域中
   *
   * @param identifier 标识符节点
   * @param binding 绑定标志
   */
  declareNameFromIdentifier(identifier: Identifier, binding: BindingFlag) {
    this.scope.declareName(identifier.name, binding, identifier.loc.start);
  }

  /**
   * 检查节点是否可以转换为剩余参数
   * 验证剩余参数语法的合法性
   *
   * @param node 要检查的节点
   * @param allowPattern 是否允许模式
   */
  checkToRestConversion(node: Node, allowPattern: boolean): void {
    switch (node.type) {
      case "ParenthesizedExpression":
        this.checkToRestConversion(node.expression, allowPattern);
        break;
      case "Identifier":
      case "MemberExpression":
        break;
      case "ArrayExpression":
      case "ObjectExpression":
        if (allowPattern) break;
      /* falls through */
      default:
        this.raise(Errors.InvalidRestAssignmentPattern, node);
    }
  }

  /**
   * 检查剩余参数后是否有逗号
   * 剩余参数必须是最后一个参数，后面不能有逗号
   *
   * @param close 关闭字符的字符码
   * @returns 是否发现了非法的逗号
   */
  checkCommaAfterRest(
    close: (typeof charCodes)[keyof typeof charCodes],
  ): boolean {
    if (!this.match(tt.comma)) {
      return false;
    }

    this.raise(
      this.lookaheadCharCode() === close
        ? Errors.RestTrailingComma
        : Errors.ElementAfterRest,
      this.state.startLoc,
    );

    return true;
  }
}
