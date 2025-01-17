// This file contains methods responsible for maintaining a TraversalContext.

import traverse from "../index";
import { SHOULD_SKIP, SHOULD_STOP } from "./index";
import type TraversalContext from "../context";
import type NodePath from "./index";

export function call(this: NodePath, key: string): boolean {
  const opts = this.opts;

  this.debug(key);

  if (this.node) {
    if (this._call(opts[key])) return true;
  }

  if (this.node) {
    return this._call(opts[this.node.type] && opts[this.node.type][key]);
  }

  return false;
}

export function _call(this: NodePath, fns?: Array<Function>): boolean {
  if (!fns) return false;

  for (const fn of fns) {
    if (!fn) continue;

    const node = this.node;
    if (!node) return true;

    const ret = fn.call(this.state, this, this.state);
    if (ret && typeof ret === "object" && typeof ret.then === "function") {
      throw new Error(
        `You appear to be using a plugin with an async traversal visitor, ` +
          `which your current version of Babel does not support. ` +
          `If you're using a published plugin, you may need to upgrade ` +
          `your @babel/core version.`,
      );
    }
    if (ret) {
      throw new Error(`Unexpected return value from visitor method ${fn}`);
    }

    // node has been replaced, it will have been requeued
    if (this.node !== node) return true;

    // this.shouldSkip || this.shouldStop || this.removed
    if (this._traverseFlags > 0) return true;
  }

  return false;
}

export function isDenylisted(this: NodePath): boolean {
  const denylist = this.opts.denylist ?? this.opts.blacklist;
  return denylist && denylist.indexOf(this.node.type) > -1;
}

// TODO: Remove in Babel 8
export { isDenylisted as isBlacklisted };

function restoreContext(path: NodePath, context: TraversalContext) {
  if (path.context !== context) {
    path.context = context;
    path.state = context.state;
    path.opts = context.opts;
  }
}

export function visit(this: NodePath): boolean {
  if (!this.node) {
    return false;
  }

  if (this.isDenylisted()) {
    return false;
  }

  if (this.opts.shouldSkip && this.opts.shouldSkip(this)) {
    return false;
  }

  const currentContext = this.context;
  // Note: We need to check "this.shouldSkip" first because
  // another visitor can set it to true. Usually .shouldSkip is false
  // before calling the enter visitor, but it can be true in case of
  // a requeued node (e.g. by .replaceWith()) that is then marked
  // with .skip().
  if (this.shouldSkip || this.call("enter")) {
    this.debug("Skip...");
    return this.shouldStop;
  }
  restoreContext(this, currentContext);

  this.debug("Recursing into...");
  traverse.node(
    this.node,
    this.opts,
    this.scope,
    this.state,
    this,
    this.skipKeys,
  );

  restoreContext(this, currentContext);

  this.call("exit");

  return this.shouldStop;
}

export function skip(this: NodePath) {
  this.shouldSkip = true;
}

export function skipKey(this: NodePath, key: string) {
  if (this.skipKeys == null) {
    this.skipKeys = {};
  }
  this.skipKeys[key] = true;
}

export function stop(this: NodePath) {
  // this.shouldSkip = true; this.shouldStop = true;
  this._traverseFlags |= SHOULD_SKIP | SHOULD_STOP;
}

export function setScope(this: NodePath) {
  if (this.opts && this.opts.noScope) return;

  let path = this.parentPath;

  // Skip method scope if is computed method key
  if (this.key === "key" && path.isMethod()) path = path.parentPath;

  let target;
  while (path && !target) {
    if (path.opts && path.opts.noScope) return;

    target = path.scope;
    path = path.parentPath;
  }

  this.scope = this.getScope(target);
  if (this.scope) this.scope.init();
}

export function setContext(this: NodePath, context?: TraversalContext) {
  if (this.skipKeys != null) {
    this.skipKeys = {};
  }
  // this.shouldSkip = false; this.shouldStop = false; this.removed = false;
  this._traverseFlags = 0;

  if (context) {
    this.context = context;
    this.state = context.state;
    this.opts = context.opts;
  }

  this.setScope();

  return this;
}

/**
 * Here we resync the node paths `key` and `container`. If they've changed according
 * to what we have stored internally then we attempt to resync by crawling and looking
 * for the new values.
 */

export function resync(this: NodePath) {
  if (this.removed) return;

  this._resyncParent();
  this._resyncList();
  this._resyncKey();
  //this._resyncRemoved();
}

export function _resyncParent(this: NodePath) {
  if (this.parentPath) {
    this.parent = this.parentPath.node;
  }
}

export function _resyncKey(this: NodePath) {
  if (!this.container) return;

  if (this.node === this.container[this.key]) return;

  // grrr, path key is out of sync. this is likely due to a modification to the AST
  // not done through our path APIs

  if (Array.isArray(this.container)) {
    for (let i = 0; i < this.container.length; i++) {
      if (this.container[i] === this.node) {
        return this.setKey(i);
      }
    }
  } else {
    for (const key of Object.keys(this.container)) {
      if (this.container[key] === this.node) {
        return this.setKey(key);
      }
    }
  }

  // ¯\_(ツ)_/¯ who knows where it's gone lol
  this.key = null;
}

export function _resyncList(this: NodePath) {
  if (!this.parent || !this.inList) return;

  const newContainer = this.parent[this.listKey];
  if (this.container === newContainer) return;

  // container is out of sync. this is likely the result of it being reassigned
  this.container = newContainer || null;
}

export function _resyncRemoved(this: NodePath) {
  if (
    this.key == null ||
    !this.container ||
    this.container[this.key] !== this.node
  ) {
    this._markRemoved();
  }
}

export function popContext(this: NodePath) {
  this.contexts.pop();
  if (this.contexts.length > 0) {
    this.setContext(this.contexts[this.contexts.length - 1]);
  } else {
    this.setContext(undefined);
  }
}

export function pushContext(this: NodePath, context: TraversalContext) {
  this.contexts.push(context);
  this.setContext(context);
}

export function setup(this: NodePath, parentPath, container, listKey, key) {
  this.listKey = listKey;
  this.container = container;

  this.parentPath = parentPath || this.parentPath;
  this.setKey(key);
}

export function setKey(this: NodePath, key) {
  this.key = key;
  this.node = this.container[this.key];
  this.type = this.node?.type;
}

export function requeue(this: NodePath, pathToQueue = this) {
  if (pathToQueue.removed) return;

  // If a path is skipped, and then replaced with a
  // new one, the new one shouldn't probably be skipped.
  if (process.env.BABEL_8_BREAKING) {
    pathToQueue.shouldSkip = false;
  }

  // TODO(loganfsmyth): This should be switched back to queue in parent contexts
  // automatically once #2892 and #4135 have been resolved. See #4140.
  // let contexts = this._getQueueContexts();
  const contexts = this.contexts;

  for (const context of contexts) {
    context.maybeQueue(pathToQueue);
  }
}

export function _getQueueContexts(this: NodePath) {
  let path = this;
  let contexts = this.contexts;
  while (!contexts.length) {
    path = path.parentPath;
    if (!path) break;
    contexts = path.contexts;
  }
  return contexts;
}
