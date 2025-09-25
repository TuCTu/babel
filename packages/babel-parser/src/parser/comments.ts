/*:: declare var invariant; */

import BaseParser from "./base.ts";
import type { Comment, Node } from "../types.ts";
import * as charCodes from "charcodes";
import type { Undone } from "./node.ts";

/**
 * A whitespace token containing comments
 */
export type CommentWhitespace = {
  /**
   * the start of the whitespace token.
   */
  start: number;
  /**
   * the end of the whitespace token.
   */
  end: number;
  /**
   * the containing comments
   */
  comments: Array<Comment>;
  /**
   * the immediately preceding AST node of the whitespace token
   */
  leadingNode: Node | null;
  /**
   * the immediately following AST node of the whitespace token
   */
  trailingNode: Node | null;
  /**
   * the innermost AST node containing the whitespace with minimal size (|end - start|)
   */
  containingNode: Node | null;
};

/**
 * Merge comments with node's trailingComments or assign comments to be
 * trailingComments. New comments will be placed before old comments
 * because the commentStack is enumerated reversely.
 * 将评论与节点的尾部评论合并，或将评论指定为
 * 尾部评论。新评论将放置在旧评论之前
 * 因为评论堆栈是反向枚举的。
 *
 */
function setTrailingComments(node: Undone<Node>, comments: Array<Comment>) {
  if (node.trailingComments === undefined) {
    node.trailingComments = comments;
  } else {
    node.trailingComments.unshift(...comments);
  }
}

/**
 * Merge comments with node's leadingComments or assign comments to be
 * leadingComments. New comments will be placed before old comments
 * because the commentStack is enumerated reversely.
 * 将评论与节点的头部评论合并，或将评论指定为
 * 头部评论。新评论将放置在旧评论之前
 * 因为评论堆栈是反向枚举的。
 */
function setLeadingComments(node: Undone<Node>, comments: Array<Comment>) {
  if (node.leadingComments === undefined) {
    node.leadingComments = comments;
  } else {
    node.leadingComments.unshift(...comments);
  }
}

/**
 * Merge comments with node's innerComments or assign comments to be
 * innerComments. New comments will be placed before old comments
 * because the commentStack is enumerated reversely.
 * 将评论与节点的内部评论合并，或将评论指定为
 * 内部评论。新评论将放置在旧评论之前
 * 因为评论堆栈是反向枚举的。
 */
export function setInnerComments(
  node: Undone<Node>,
  comments?: Array<Comment>,
) {
  if (node.innerComments === undefined) {
    node.innerComments = comments;
  } else {
    node.innerComments.unshift(...comments);
  }
}

/**
 * Given node and elements array, if elements has non-null element,
 * merge comments to its trailingComments, otherwise merge comments
 * to node's innerComments
 * 给定节点和元素数组，如果元素有非 null 元素，则将注释合并到其 trailingComments 中，否则将注释合并到节点的 innerComments 中
 *
 * @example 例子1：对象表达式中的注释处理
 * ```javascript
 * const obj = {
 *   a: 1,
 *   b: 2, // 尾随逗号
 *   // 这个注释跟在逗号后面
 * };
 * ```
 * 结果：注释被设置为属性 b 的 trailingComments
 *
 * @example 例子2：空数组或所有元素为null的情况
 * ```javascript
 * const emptyArr = [
 *   , // 空元素
 *   , // 空元素
 *   // 注释
 * ];
 * ```
 * 结果：注释被设置为整个数组表达式的 innerComments
 *
 * @example 例子3：函数参数中的注释处理
 * ```javascript
 * function test(
 *   a,
 *   b,
 *   // 参数后的注释
 * ) {}
 * ```
 * 结果：注释会根据位置被分配给最后一个参数的 trailingComments 或函数的 innerComments
 */
function adjustInnerComments(
  node: Undone<Node>,
  elements: Array<Node>,
  commentWS: CommentWhitespace,
) {
  let lastElement = null;
  let i = elements.length;
  while (lastElement === null && i > 0) {
    lastElement = elements[--i];
  }
  if (lastElement === null || lastElement.start > commentWS.start) {
    setInnerComments(node, commentWS.comments);
  } else {
    setTrailingComments(lastElement, commentWS.comments);
  }
}

/**
 * CommentsParser 类的主要作用是在Babel解析过程中正确地处理和保留JavaScript/TypeScript源代码中的注释信息，
 * 并将这些注释准确地关联到相应的AST（抽象语法树）节点上。
 *
 * ## 核心功能
 *
 * ### 1. 注释与AST节点的正确关联
 * 解析器需要决定每个注释应该归属于哪个AST节点，例如：
 * ```javascript
 * const obj = {
 *   a: 1, // 这是属性a的注释
 *   // 这是对象内部的注释
 *   b: 2
 * };
 * ```
 *
 * ### 2. 三种注释类型的精确分类
 * - **leadingComments（前导注释）**：出现在节点之前的注释
 * - **trailingComments（尾随注释）**：跟随在节点后面的注释
 * - **innerComments（内部注释）**：包含在复合节点内部的注释
 *
 * ### 3. 复杂场景的注释归属处理
 * 通过CommentWhitespace数据结构追踪每个注释的：
 * - 位置信息（start、end）
 * - 相邻节点（leadingNode、trailingNode）
 * - 包含节点（containingNode - 最小包含该注释的AST节点）
 *
 * ### 4. 特殊语法结构的注释处理
 * 专门处理各种复杂场景：
 * - 尾随逗号后的注释归属
 * - 函数参数中的注释分配
 * - 数组/对象元素间的注释处理
 * - 空元素或null元素的注释归属
 *
 * ### 5. 动态重新分配注释归属
 * 在解析过程中动态调整注释的归属关系，例如async函数的解析过程中
 * 需要将最初分配给async标识符的注释重新分配给函数节点。
 *
 * ## 转换链中的作用
 * 在Babel的 **源码→AST→目标码** 转换链中起到：
 * - **保真度保证**：确保注释信息不丢失
 * - **语义准确性**：注释与正确的代码元素关联
 * - **工具支持**：为代码格式化、文档生成、静态分析等工具提供准确的注释位置信息
 *
 * **最终目标**：让转换后的代码能够保持原有的注释结构和语义，支持如Prettier等格式化工具
 * 能够正确地重新排列和输出注释，确保在各种复杂的语法转换过程中，开发者编写的注释信息
 * 能够得到妥善的处理和保留。
 */
export default class CommentsParser extends BaseParser {
  addComment(comment: Comment): void {
    if (this.filename) comment.loc.filename = this.filename;
    const { commentsLen } = this.state;
    if (this.comments.length !== commentsLen) {
      this.comments.length = commentsLen;
    }
    this.comments.push(comment);
    this.state.commentsLen++;
  }

  /**
   * Given a newly created AST node _n_, attach _n_ to a comment whitespace _w_ if applicable
   * 给定一个新创建的 AST 节点 _n_，如果适用，则将 _n_ 附加到注释空白 _w_ 上
   *
   * {@see {@link CommentWhitespace}}
   */
  processComment(node: Node): void {
    const { commentStack } = this.state;
    const commentStackLength = commentStack.length;
    if (commentStackLength === 0) return;
    let i = commentStackLength - 1;
    const lastCommentWS = commentStack[i];

    if (lastCommentWS.start === node.end) {
      lastCommentWS.leadingNode = node;
      i--;
    }

    const { start: nodeStart } = node;
    // invariant: for all 0 <= j <= i, let c = commentStack[j], c must satisfy c.end < node.end
    // 不变式：对于所有 0 <= j <= i，令 c = commentStack[j]，c 必须满足 c.end < node.end
    for (; i >= 0; i--) {
      const commentWS = commentStack[i];
      const commentEnd = commentWS.end;
      if (commentEnd > nodeStart) {
        // by definition of commentWhiteSpace, this implies commentWS.start > nodeStart
        // so node can be a containingNode candidate. At this time we can finalize the comment
        // whitespace, because
        // 1) its leadingNode or trailingNode, if exists, will not change
        // 2) its containingNode have been assigned and will not change because it is the
        //    innermost minimal-sized AST node

        // 根据 commentWhiteSpace 的定义，这意味着 commentWS.start > nodeStart
        // 因此 node 可以作为包含节点的候选。此时我们可以最终确定注释
        // 空格，因为
        // 1) 它的 leadingNode 或 trailingNode（如果存在）不会改变
        // 2) 它的包含节点已被赋值，并且不会改变，因为它是
        // 最内层的最小 AST 节点
        commentWS.containingNode = node;
        this.finalizeComment(commentWS);
        commentStack.splice(i, 1);
      } else {
        if (commentEnd === nodeStart) {
          commentWS.trailingNode = node;
        }
        // stop the loop when commentEnd <= nodeStart
        break;
      }
    }
  }

  /**
   * Assign the comments of comment whitespaces to related AST nodes.
   * Also adjust innerComments following trailing comma.
   * 将注释空格的注释分配给相关的 AST 节点。
   * 还调整尾随逗号后面的内部注释。
   */
  finalizeComment(commentWS: CommentWhitespace) {
    const { comments } = commentWS;
    if (commentWS.leadingNode !== null || commentWS.trailingNode !== null) {
      if (commentWS.leadingNode !== null) {
        setTrailingComments(commentWS.leadingNode, comments);
      }
      if (commentWS.trailingNode !== null) {
        setLeadingComments(commentWS.trailingNode, comments);
      }
    } else {
      // 这是一条 Flow 类型检查的断言，意思是“此处 commentWS.containingNode 一定不为 null”
      /*:: invariant(commentWS.containingNode !== null) */
      const { containingNode: node, start: commentStart } = commentWS;
      if (
        this.input.charCodeAt(this.offsetToSourcePos(commentStart) - 1) ===
        charCodes.comma
      ) {
        // If a commentWhitespace follows a comma and the containingNode allows
        // list structures with trailing comma, merge it to the trailingComment
        // of the last non-null list element
        // 如果一个注释空白后面跟着一个逗号，并且包含节点允许列表结构有尾随逗号，则将其合并到列表最后一个非 null 元素的 trailingComment 中
        // 这里的 node 是包含节点的 AST 节点
        switch (node.type) {
          case "ObjectExpression":
          case "ObjectPattern":
          case "RecordExpression":
            adjustInnerComments(node, node.properties, commentWS);
            break;
          case "CallExpression":
          case "OptionalCallExpression":
            adjustInnerComments(node, node.arguments, commentWS);
            break;
          case "ImportExpression":
            adjustInnerComments(
              node,
              [node.source, node.options ?? null],
              commentWS,
            );
            break;
          case "FunctionDeclaration":
          case "FunctionExpression":
          case "ArrowFunctionExpression":
          case "ObjectMethod":
          case "ClassMethod":
          case "ClassPrivateMethod":
            adjustInnerComments(node, node.params, commentWS);
            break;
          case "ArrayExpression":
          case "ArrayPattern":
          case "TupleExpression":
            adjustInnerComments(node, node.elements, commentWS);
            break;
          case "ExportNamedDeclaration":
          case "ImportDeclaration":
            adjustInnerComments(node, node.specifiers, commentWS);
            break;
          case "TSEnumDeclaration":
            if (!process.env.BABEL_8_BREAKING) {
              adjustInnerComments(node, node.members, commentWS);
            } else {
              setInnerComments(node, comments);
            }
            break;
          case "TSEnumBody":
            adjustInnerComments(node, node.members, commentWS);
            break;
          default: {
            setInnerComments(node, comments);
          }
        }
      } else {
        setInnerComments(node, comments);
      }
    }
  }

  /**
   * Drains remaining commentStack and applies finalizeComment
   * to each comment whitespace. Used only in parseExpression
   * where the top level AST node is _not_ Program
   * {@see {@link CommentsParser#finalizeComment}}
   * 将剩余的 commentStack 清空，并调用 finalizeComment 处理每个注释空白
   * 这个方法只在 parseExpression 中使用，因为顶层 AST 节点不是 Program
   */
  finalizeRemainingComments() {
    const { commentStack } = this.state;
    for (let i = commentStack.length - 1; i >= 0; i--) {
      this.finalizeComment(commentStack[i]);
    }
    this.state.commentStack = [];
  }

  /* eslint-disable no-irregular-whitespace */
  /**
   * Reset previous node trailing comments. Used in object / class
   * property parsing. We parse `async`, `static`, `set` and `get`
   * as an identifier but may reinterpret it into an async/static/accessor
   * method later. In this case the identifier is not part of the AST and we
   * should sync the knowledge to commentStacks
   *
   * For example, when parsing
   * ```
   * async /* 1 *​/ function f() {}
   * ```
   * the comment whitespace `/* 1 *​/` has leading node Identifier(async). When
   * we see the function token, we create a Function node and mark `/* 1 *​/` as
   * inner comments. So `/* 1 *​/` should be detached from the Identifier node.
   * 重置前一个节点的尾部注释。用于对象/类
   * 属性解析。我们将 `async`、`static`、`set` 和 `get`
   * 解析为标识符，但稍后可能会将其重新解释为异步/静态/访问器
   * 方法。在这种情况下，标识符不是抽象语法树 (AST) 的一部分，我们
   * 应该将相关知识同步到 commentStacks
   *
   * 例如，在解析
   * ```javascript
   * async /* 1 *​/ function f() {}
   * ```
   * 注释空格 `/* 1 *​/` 的前导节点是 Identifier(async)。当
   * 看到函数标记时，我们会创建一个 Function 节点，并将 `/* 1 *​/` 标记为
   * 内部注释。因此，`/* 1 *​/` 应该与 Identifier 节点分离。
   *
   * @param node the last finished AST node _before_ current token
   */
  /* eslint-enable no-irregular-whitespace */
  resetPreviousNodeTrailingComments(node: Node) {
    const { commentStack } = this.state;
    const { length } = commentStack;
    if (length === 0) return;
    const commentWS = commentStack[length - 1];
    if (commentWS.leadingNode === node) {
      commentWS.leadingNode = null;
    }
  }

  /**
   * Attach a node to the comment whitespaces right before/after
   * the given range.
   *
   * This is used to properly attach comments around parenthesized
   * expressions as leading/trailing comments of the inner expression.
   * 将节点附加到给定范围之前/之后的注释空格。
   * 这用于正确地将括号表达式周围的注释附加为内部表达式的前导/尾随注释。
   * 表达式。
   *
   */
  takeSurroundingComments(node: Node, start: number, end: number) {
    const { commentStack } = this.state;
    const commentStackLength = commentStack.length;
    if (commentStackLength === 0) return;
    let i = commentStackLength - 1;

    for (; i >= 0; i--) {
      const commentWS = commentStack[i];
      const commentEnd = commentWS.end;
      const commentStart = commentWS.start;

      if (commentStart === end) {
        commentWS.leadingNode = node;
      } else if (commentEnd === start) {
        commentWS.trailingNode = node;
      } else if (commentEnd < start) {
        break;
      }
    }
  }
}
