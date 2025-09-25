/**
 * Node 工具类文件 - Babel 解析器中的 AST 节点创建和管理
 *
 * 这个文件定义了 Babel 解析器中 AST（抽象语法树）节点的基础结构和操作方法。
 * 它提供了创建、完成、克隆和修改 AST 节点所需的所有核心功能。
 *
 * ## 主要组件
 *
 * ### 1. Node 类
 * - AST 节点的基础实现类
 * - 包含位置信息、类型信息和注释信息
 * - 支持范围信息和额外属性
 *
 * ### 2. NodeUtils 抽象类
 * - 继承自 UtilParser
 * - 提供节点创建、完成、重置等工具方法
 * - 支持节点克隆和类型转换
 *
 * ## 在解析流程中的作用
 *
 * 在 Babel 的解析过程中，每当识别出一个语法结构时，就会创建对应的 AST 节点。
 * 这个文件提供了统一的节点创建和管理接口，确保所有节点都有正确的位置信息、
 * 类型信息和其他必要的元数据。
 */

import UtilParser from "./util.ts";
import { SourceLocation, type Position } from "../util/location.ts";
import type {
  Comment,
  Node as NodeType,
  NodeBase,
  EstreeLiteral,
  Identifier,
  Placeholder,
  StringLiteral,
} from "../types.ts";
import { OptionFlags } from "../options.ts";

// Start an AST node, attaching a start offset.
// 启动 AST 节点，附加开始偏移量

/**
 * Node 类是所有 AST 节点的基础实现
 * 实现了 NodeBase 接口，包含节点的基本属性和位置信息
 *
 * 每个 AST 节点都包含：
 * - 位置信息：start、end、loc、range
 * - 类型信息：type
 * - 注释信息：leadingComments、trailingComments、innerComments
 * - 额外属性：extra（用于存储特定于工具的元数据）
 */
class Node implements NodeBase {
  /**
   * Node 构造函数
   * 创建一个新的 AST 节点，初始化位置信息
   *
   * @param parser 解析器实例，用于获取配置选项
   * @param pos 节点开始位置的字符索引
   * @param loc 节点开始位置的行列信息
   */
  constructor(parser: UtilParser, pos: number, loc: Position) {
    this.start = pos; // 节点开始的字符索引
    this.end = 0; // 节点结束的字符索引（稍后设置）
    this.loc = new SourceLocation(loc); // 源码位置信息（行列）
    // 如果启用了范围选项，则设置范围数组
    if (parser?.optionFlags & OptionFlags.Ranges) this.range = [pos, 0];
    // 如果解析器有文件名，则设置到位置信息中
    if (parser?.filename) this.loc.filename = parser.filename;
  }

  type: string = ""; // 节点类型（如 "Identifier", "BinaryExpression" 等）
  declare start: number; // 节点开始位置（字符索引）
  declare end: number; // 节点结束位置（字符索引）
  declare loc: SourceLocation; // 源码位置信息（行列号）
  declare range: [number, number]; // 节点范围数组 [start, end]
  declare leadingComments: Array<Comment>; // 前导注释（节点前面的注释）
  declare trailingComments: Array<Comment>; // 尾随注释（节点后面的注释）
  declare innerComments: Array<Comment>; // 内部注释（节点内部的注释）
  declare extra: {
    // 额外属性（工具特定的元数据）
    [key: string]: any;
  };
}
/**
 * Node 原型对象的引用，用于性能优化的克隆操作
 */
const NodePrototype = Node.prototype;

/**
 * 为了向后兼容，在非 Babel 8 环境中添加 __clone 方法
 * 这个方法用于深度克隆 AST 节点，但不包括注释信息
 */
if (!process.env.BABEL_8_BREAKING) {
  // @ts-expect-error __clone is not defined in Node prototype
  // 在 Node 原型上添加 __clone 方法用于节点克隆
  NodePrototype.__clone = function (): Node {
    // 创建新节点实例
    const newNode = new Node(undefined, this.start, this.loc.start);
    const keys = Object.keys(this) as (keyof Node)[];
    // 遍历原节点的所有属性
    for (let i = 0, length = keys.length; i < length; i++) {
      const key = keys[i];
      // Do not clone comments that are already attached to the node
      // 不克隆已经附加到节点的注释信息，避免重复
      if (
        key !== "leadingComments" &&
        key !== "trailingComments" &&
        key !== "innerComments"
      ) {
        // @ts-expect-error cloning this to newNode
        // 将原节点的属性复制到新节点
        newNode[key] = this[key];
      }
    }

    return newNode;
  };
}

/**
 * Undone 类型定义
 * 表示一个尚未完成的 AST 节点（缺少 type 属性）
 * 在节点创建过程中，先创建 Undone 节点，然后通过 finishNode 添加 type 属性
 *
 * @template T 继承自 NodeType 的节点类型
 */
export type Undone<T extends NodeType> = Omit<T, "type">;

/**
 * NodeUtils 抽象类
 * 继承自 UtilParser，提供 AST 节点创建、完成、修改等工具方法
 *
 * ## 主要功能
 *
 * ### 1. 节点创建
 * - startNode(): 在当前位置创建新节点
 * - startNodeAt(): 在指定位置创建新节点
 * - startNodeAtNode(): 基于现有节点位置创建新节点
 *
 * ### 2. 节点完成
 * - finishNode(): 完成节点，设置类型和结束位置
 * - finishNodeAt(): 在指定位置完成节点
 *
 * ### 3. 位置管理
 * - resetStartLocation(): 重置节点开始位置
 * - resetEndLocation(): 重置节点结束位置
 * - resetStartLocationFromNode(): 从另一个节点复制开始位置
 *
 * ### 4. 节点操作
 * - castNodeTo(): 将节点转换为指定类型
 * - cloneIdentifier(): 克隆标识符节点
 * - cloneStringLiteral(): 克隆字符串字面量节点
 */
export abstract class NodeUtils extends UtilParser {
  /**
   * 在当前解析器位置创建一个新的 AST 节点
   * 使用当前 token 的开始位置作为节点的开始位置
   *
   * @template T 要创建的节点类型
   * @returns 未完成的节点（缺少 type 属性）
   */
  startNode<T extends NodeType = never>(): Undone<T> {
    const loc = this.state.startLoc; // 获取当前 token 的开始位置
    return new Node(this, loc.index, loc) as unknown as Undone<T>;
  }

  /**
   * 在指定位置创建一个新的 AST 节点
   *
   * @template T 要创建的节点类型
   * @param loc 节点的开始位置
   * @returns 未完成的节点（缺少 type 属性）
   */
  startNodeAt<T extends NodeType = never>(loc: Position): Undone<T> {
    return new Node(this, loc.index, loc) as unknown as Undone<T>;
  }

  /**
   * Start a new node with a previous node's location.
   * 使用前一个节点的位置创建新节点
   *
   * 这个方法常用于需要将多个语法结构合并为一个节点的情况，
   * 新节点会继承现有节点的开始位置
   *
   * @template T 要创建的节点类型
   * @param type 现有的未完成节点，用于获取位置信息
   * @returns 新的未完成节点
   */
  startNodeAtNode<T extends NodeType = never>(
    type: Undone<NodeType>,
  ): Undone<T> {
    return this.startNodeAt(type.loc.start);
  }

  // Finish an AST node, adding `type` and `end` properties.
  // 完成 AST 节点，添加 `type` 和 `end` 属性

  /**
   * 完成一个 AST 节点，设置节点类型和结束位置
   * 使用当前解析器的最后一个 token 的结束位置作为节点的结束位置
   *
   * @template T 节点的具体类型
   * @param node 未完成的节点
   * @param type 节点的类型字符串
   * @returns 完成的节点
   */
  finishNode<T extends NodeType>(node: Undone<T>, type: T["type"]): T {
    return this.finishNodeAt(node, type, this.state.lastTokEndLoc);
  }

  // Finish node at given position
  // 在给定位置完成节点

  /**
   * 在指定位置完成一个 AST 节点
   * 这是节点完成的核心方法，设置节点的类型、结束位置，并处理注释
   *
   * @template T 节点的具体类型
   * @param node 未完成的节点
   * @param type 节点的类型字符串
   * @param endLoc 节点的结束位置
   * @returns 完成的节点
   */
  finishNodeAt<T extends NodeType>(
    node: Omit<T, "type">,
    type: T["type"],
    endLoc: Position,
  ): T {
    // 开发环境下检查是否重复调用 finishNode
    if (process.env.NODE_ENV !== "production" && node.end > 0) {
      throw new Error(
        "Do not call finishNode*() twice on the same node." +
          " Instead use resetEndLocation() or change type directly.",
      );
    }
    // 设置节点类型
    (node as T).type = type;
    // 设置节点结束位置
    node.end = endLoc.index;
    node.loc.end = endLoc;
    // 如果启用了范围选项，设置范围结束位置
    if (this.optionFlags & OptionFlags.Ranges) node.range[1] = endLoc.index;
    // 如果启用了注释附加选项，处理节点注释
    if (this.optionFlags & OptionFlags.AttachComment) {
      this.processComment(node as T);
    }
    return node as T;
  }

  /**
   * 重置节点的开始位置
   * 用于需要调整节点位置信息的场景
   *
   * @param node 要重置的节点
   * @param startLoc 新的开始位置
   */
  resetStartLocation(node: NodeBase, startLoc: Position): void {
    node.start = startLoc.index; // 重置字符索引
    node.loc.start = startLoc; // 重置行列位置
    // 如果启用了范围选项，重置范围开始位置
    if (this.optionFlags & OptionFlags.Ranges) node.range[0] = startLoc.index;
  }

  /**
   * 重置节点的结束位置
   * 默认使用当前解析器的最后一个 token 的结束位置
   *
   * @param node 要重置的节点
   * @param endLoc 新的结束位置，默认为最后一个 token 的结束位置
   */
  resetEndLocation(
    node: NodeBase,
    endLoc: Position = this.state.lastTokEndLoc,
  ): void {
    node.end = endLoc.index; // 重置字符索引
    node.loc.end = endLoc; // 重置行列位置
    // 如果启用了范围选项，重置范围结束位置
    if (this.optionFlags & OptionFlags.Ranges) node.range[1] = endLoc.index;
  }

  /**
   * Reset the start location of node to the start location of locationNode
   * 将节点的开始位置重置为另一个节点的开始位置
   *
   * 这个方法常用于需要将一个节点的位置信息同步到另一个节点的场景
   *
   * @param node 要重置开始位置的节点
   * @param locationNode 提供位置信息的源节点
   */
  resetStartLocationFromNode(node: NodeBase, locationNode: NodeBase): void {
    this.resetStartLocation(node, locationNode.loc.start);
  }

  /**
   * 将节点强制转换为指定类型
   * 这是一个类型安全的转换方法，用于在运行时改变节点的类型
   *
   * @template T 目标节点类型字符串
   * @param node 要转换的节点
   * @param type 目标类型
   * @returns 转换后的节点
   */
  castNodeTo<T extends NodeType["type"]>(
    node: NodeType,
    type: T,
  ): Extract<NodeType, { type: T }> {
    node.type = type; // 设置新的节点类型
    return node as Extract<NodeType, { type: T }>;
  }

  /**
   * 克隆标识符或占位符节点
   * 创建一个新的标识符节点，复制原节点的所有基本属性
   *
   * @template T 标识符或占位符类型
   * @param node 要克隆的节点
   * @returns 克隆的节点
   */
  cloneIdentifier<T extends Identifier | Placeholder>(node: T): T {
    // We don't need to clone `typeAnnotations` and `optional`: because
    // cloneIdentifier is only used in object shorthand and named import/export.
    // Neither of them allow type annotations after the identifier or optional identifier
    // 我们不需要克隆 `typeAnnotations` 和 `optional`：因为
    // cloneIdentifier 只用于对象简写和命名导入/导出。
    // 这两种情况都不允许在标识符后面使用类型注解或可选标识符
    const { type, start, end, loc, range, name } = node;
    const cloned = Object.create(NodePrototype); // 基于 Node 原型创建新对象
    cloned.type = type; // 节点类型
    cloned.start = start; // 开始位置
    cloned.end = end; // 结束位置
    cloned.loc = loc; // 位置信息
    cloned.range = range; // 范围信息
    cloned.name = name; // 标识符名称
    // 如果原节点有额外属性，也复制过来
    if (node.extra) cloned.extra = node.extra;
    return cloned;
  }

  /**
   * 克隆字符串字面量节点
   * 创建一个新的字符串字面量节点，复制原节点的所有属性
   *
   * @template T 字符串字面量、ESTree 字面量或占位符类型
   * @param node 要克隆的节点
   * @returns 克隆的节点
   */
  cloneStringLiteral<T extends StringLiteral | EstreeLiteral | Placeholder>(
    node: T,
  ): T {
    const { type, start, end, loc, range, extra } = node;
    const cloned = Object.create(NodePrototype); // 基于 Node 原型创建新对象
    cloned.type = type; // 节点类型
    cloned.start = start; // 开始位置
    cloned.end = end; // 结束位置
    cloned.loc = loc; // 位置信息
    cloned.range = range; // 范围信息
    cloned.extra = extra; // 额外属性
    cloned.value = (node as StringLiteral).value; // 字符串值
    return cloned;
  }
}
