import type { Server, ServerWebSocket } from "bun";
import { Context, WSContext } from "./context";
import { SystemErr, SystemErrCode } from "./errors";

type WSOpenFunc = (ws: ServerWebSocket<any>) => void | Promise<void>;
type WSMessageFunc = (ws: ServerWebSocket<any>, message: string | Buffer<ArrayBufferLike>) => void | Promise<void>;
type WSCloseFunc = (ws: ServerWebSocket<any>, code: number, message: string) => void | Promise<void>;
type WSDrainFunc = (ws: ServerWebSocket<any>) => void | Promise<void>;
type WSOnConnect = (c: WSContext) => void | Promise<void>;

type HandlerResponse = Response | string | object;
export type HandlerFunc<Res extends HandlerResponse = HandlerResponse> = (c: Context) => Res | Promise<Res>;

export class Handler {
  private mainHandler: HandlerFunc;
  private middlewares: Middleware[];
  private compiledChain: (c: Context) => Promise<HandlerResponse>;

  constructor(mainHandler: HandlerFunc) {
    this.mainHandler = mainHandler;
    this.middlewares = [];
    this.compiledChain = async (c: Context) => await this.mainHandler(c);
  }

  setMiddlewares(middlewares: Middleware[]) {
    this.middlewares = middlewares;
    this.precompileChain();
  }

  private precompileChain() {
    let chain = async (context: Context): Promise<HandlerResponse> => {
      try {
        return await this.mainHandler(context);
      } catch (error) {
        throw error;
      }
    };

    // Apply middlewares in reverse order
    for (let i = this.middlewares.length - 1; i >= 0; i--) {
      const middleware = this.middlewares[i];
      const nextChain = chain;
      chain = async (context: Context): Promise<HandlerResponse> => {
        try {
          const result = await middleware.execute(context, async () => {
            const response = await nextChain(context);
            return response;
          });

          if (!result) {
            throw new Error("no result?");
          }
          return result;
        } catch (error) {
          throw error;
        }
      };
    }

    this.compiledChain = chain;
  }

  async execute(c: Context): Promise<Response> {
    const result = await this.compiledChain(c);
    if (result instanceof Response) {
      return result;
    } else if (typeof result === "number" || typeof result === "string") {
      return c.text(result);
    } else {
      return c.json(result);
    }
  }
}

export type MiddlewareNextFn = () => Promise<void | HandlerResponse>;

export type MiddlewareFn = (c: Context, next: MiddlewareNextFn) => Promise<void | HandlerResponse>;

export class Middleware {
  private callback: MiddlewareFn;

  constructor(callback: MiddlewareFn) {
    this.callback = callback;
  }

  async execute(c: Context, next: () => Promise<void | HandlerResponse>): Promise<void | HandlerResponse> {
    return this.callback(c, next);
  }
}

export const logger = new Middleware(async (c: Context, next) => {
  const start = performance.now();
  await next();
  const duration = performance.now() - start;
  console.log(`[${c.req.method}][${c.path}][${duration.toFixed(2)}ms]`);
});

class TrieNode {
  handlers: Record<string, Handler> = {};
  children: Record<string, TrieNode> = {};
  paramKey?: string;
  wildcard?: TrieNode;
}

export class RouteGroup {
  app: Router;
  prefixPath: string;
  middlewares: Middleware[];
  constructor(app: Router, prefixPath: string, ...middlewares: Middleware[]) {
    this.app = app;
    this.prefixPath = prefixPath;
    this.middlewares = middlewares;
  }

  get(path: string, handler: HandlerFunc, ...middlewares: Middleware[]) {
    this.app.get(this.prefixPath + path, handler, ...this.middlewares.concat(middlewares));
    return this;
  }

  post(path: string, handler: HandlerFunc, ...middlewares: Middleware[]) {
    this.app.post(this.prefixPath + path, handler, ...this.middlewares.concat(middlewares));
    return this;
  }

  put(path: string, handler: HandlerFunc, ...middlewares: Middleware[]) {
    this.app.put(this.prefixPath + path, handler, ...this.middlewares.concat(middlewares));
    return this;
  }

  delete(path: string, handler: HandlerFunc, ...middlewares: Middleware[]) {
    this.app.delete(this.prefixPath + path, handler, ...this.middlewares.concat(middlewares));
    return this;
  }

  patch(path: string, handler: HandlerFunc, ...middlewares: Middleware[]) {
    this.app.patch(this.prefixPath + path, handler, ...this.middlewares.concat(middlewares));
    return this;
  }

  ws(
    path: string,
    handlers: {
      open?: WSOpenFunc;
      message?: WSMessageFunc;
      close?: WSCloseFunc;
      drain?: WSDrainFunc;
      onConnect?: WSOnConnect;
    },
  ) {
    this.app.ws(this.prefixPath + path, handlers);
  }

  group(prefixPath: string, ...middlewares: Middleware[]) {
    return new RouteGroup(this.app, this.prefixPath + prefixPath, ...middlewares);
  }
}

type RouterCtorOpts = {
  auth?: {
    path: string;
    getSession: (c: Context) => Promise<{ user: any; session: any } | null>;
    handler: (r: Request) => Promise<Response>;
  };
};
export default class Router {
  DEBUG_MODE = false;
  private root: TrieNode = new TrieNode();
  private routes: Record<string, Handler> = {}; // Replacing Map with object
  private globalMiddlewares: Middleware[] = [];
  private notFoundHandler?: Handler;
  private errHandler?: Handler;
  private resolvedRoutes = new Map<string, { handler?: Handler; params: Record<string, string> }>();
  private readonly MAX_CACHE_SIZE = 100;
  private wsOpenRoutes: Record<string, WSOpenFunc> = {};
  private wsMessageRoutes: Record<string, WSMessageFunc> = {};
  private wsCloseRoutes: Record<string, WSCloseFunc> = {};
  private wsDrainRoutes: Record<string, WSDrainFunc> = {};
  private wsOnConnects: Record<string, WSOnConnect> = {};
  private wsRoutes: Record<string, boolean> = {};

  constructor(opts: RouterCtorOpts) {
    this.#setupAuth(opts?.auth);
  }

  ws(
    path: string,
    handlers: {
      open?: WSOpenFunc;
      message?: WSMessageFunc;
      close?: WSCloseFunc;
      drain?: WSDrainFunc;
      onConnect?: WSOnConnect;
    },
  ) {
    this.wsRoutes[path] = true;
    if (handlers.open) this.wsOpenRoutes[path] = handlers.open;
    if (handlers.message) this.wsMessageRoutes[path] = handlers.message;
    if (handlers.close) this.wsCloseRoutes[path] = handlers.close;
    if (handlers.drain) this.wsDrainRoutes[path] = handlers.drain;
    if (handlers.onConnect) this.wsOnConnects[path] = handlers.onConnect;
  }

  use(...middlewares: Middleware[]) {
    this.globalMiddlewares.push(...middlewares);
  }

  group(prefixPath: string, ...middlewares: Middleware[]) {
    return new RouteGroup(this, prefixPath, ...middlewares);
  }

  onErr(handlerFunc: HandlerFunc, ...middlewares: Middleware[]) {
    let handler = new Handler(handlerFunc);
    handler.setMiddlewares(this.globalMiddlewares.concat(middlewares));
    this.errHandler = handler;
  }

  onNotFound(handlerFunc: HandlerFunc, ...middlewares: Middleware[]) {
    let handler = new Handler(handlerFunc);
    handler.setMiddlewares(this.globalMiddlewares.concat(middlewares));
    this.notFoundHandler = handler;
  }

  private register(method: string, path: string, handlerFunc: HandlerFunc, middlewares: Middleware[]) {
    try {
      let handler = new Handler(handlerFunc);
      handler.setMiddlewares(this.globalMiddlewares.concat(middlewares));

      if (!path.includes(":") && !path.includes("*")) {
        if (this.routes[`${method} ${path}`]) {
          throw new SystemErr(SystemErrCode.ROUTE_ALREADY_REGISTERED, `Route ${method} ${path} has already been registered`);
        }
        this.routes[`${method} ${path}`] = handler;
        return;
      }

      const parts = path.split("/").filter(Boolean);
      let node = this.root;

      for (const part of parts) {
        let isParam = part.startsWith(":");
        let isWildcard = part === "*";

        if (isParam) {
          node = node.children[":param"] ?? (node.children[":param"] = new TrieNode());
          node.paramKey ||= part.slice(1);
        } else if (isWildcard) {
          node.wildcard = node.wildcard ?? new TrieNode();
          node = node.wildcard;
        } else {
          node = node.children[part] ?? (node.children[part] = new TrieNode());
        }
      }

      if (node.handlers[method]) {
        throw new SystemErr(SystemErrCode.ROUTE_ALREADY_REGISTERED, `Route ${method} ${path} has already been registered`);
      }
      node.handlers[method] = handler;
    } catch (err) {
      throw err;
    }
  }

  get(path: string, handler: HandlerFunc, ...middlewares: Middleware[]) {
    this.register("GET", path, handler, middlewares);
    return this;
  }

  post(path: string, handler: HandlerFunc, ...middlewares: Middleware[]) {
    this.register("POST", path, handler, middlewares);
    return this;
  }

  put(path: string, handler: HandlerFunc, ...middlewares: Middleware[]) {
    this.register("PUT", path, handler, middlewares);
    return this;
  }

  delete(path: string, handler: HandlerFunc, ...middlewares: Middleware[]) {
    this.register("DELETE", path, handler, middlewares);
    return this;
  }

  patch(path: string, handler: HandlerFunc, ...middlewares: Middleware[]) {
    this.register("PATCH", path, handler, middlewares);
    return this;
  }

  find(method: string, path: string): { handler?: Handler; params: Record<string, string> } {
    const cacheKey = `${method} ${path}`;

    if (this.routes[cacheKey]) {
      return { handler: this.routes[cacheKey], params: {} };
    }

    const cached = this.resolvedRoutes.get(cacheKey);
    if (cached) {
      return cached;
    }

    const parts = path.split("/").filter(Boolean);
    let node: TrieNode = this.root;
    let params: Record<string, string> = {};

    for (const part of parts) {
      let exactMatch: TrieNode | undefined = node.children[part];
      let paramMatch: TrieNode | undefined = node.children[":param"];
      let wildcardMatch: TrieNode | undefined = node.wildcard;

      if (exactMatch) {
        node = exactMatch;
      } else if (paramMatch) {
        node = paramMatch;
        if (node.paramKey) {
          params[node.paramKey] = part;
        }
      } else if (wildcardMatch) {
        node = wildcardMatch;
        break;
      } else {
        return { handler: undefined, params: {} };
      }
    }

    const matchedHandler: Handler | undefined = node.handlers[method];
    if (!matchedHandler) {
      return { handler: undefined, params: {} };
    }

    if (this.resolvedRoutes.size >= this.MAX_CACHE_SIZE) {
      const oldestKey = this.resolvedRoutes.keys().next().value;
      if (oldestKey !== undefined) {
        this.resolvedRoutes.delete(oldestKey);
      }
    }

    const result = { handler: matchedHandler, params };
    this.resolvedRoutes.set(cacheKey, result);
    return result;
  }

  async handleHTTP(req: Request, server: Server): Promise<Response | void> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // determine if a ws path has been hit
    if (this.wsRoutes[path]) {
      return await this.handleWS(req, server, path);
    }

    try {
      const { handler, params } = this.find(method, path);
      if (handler) {
        const context = new Context(req, params);
        return await handler.execute(context);
      }
      if (this.notFoundHandler) {
        return this.notFoundHandler.execute(new Context(req));
      }
      throw new SystemErr(SystemErrCode.ROUTE_NOT_FOUND, `${method} ${path} is not registered`);
    } catch (e: any) {
      // setting up our context with an error
      let c = new Context(req);
      c.setErr(e);

      // catching all system-level errors (errors that can occur within functions provided by Xerus)
      if (e instanceof SystemErr) {
        // let errHandler = SystemErrRecord[e.typeOf];
        // return await errHandler(c);
      }

      // if the user has default error handling
      if (this.errHandler) {
        return this.errHandler.execute(c);
      }
    }
  }

  async handleWS(req: Request, server: Server, path: string): Promise<Response | void> {
    try {
      let context = new WSContext(req, path);
      if (this.wsOnConnects[path]) {
        let onConnect = this.wsOnConnects[path];
        await onConnect(context);
        await this.wsOnConnects[path](context);
      }
      if (server.upgrade(req, context)) {
        return;
      }
    } catch (e: any) {
      throw new SystemErr(SystemErrCode.WEBSOCKET_UPGRADE_FAILURE, e.message);
    }
  }

  async handleOpenWS(ws: ServerWebSocket<unknown>) {
    let data = ws.data as any;
    let handler = this.wsOpenRoutes[data.path];
    if (handler) await handler(ws);
  }

  private async handleMessageWS(ws: ServerWebSocket<unknown>, message: string | Buffer<ArrayBufferLike>) {
    let data = ws.data as any;
    let handler = this.wsMessageRoutes[data.path];
    if (handler) await handler(ws, message);
  }

  private async handleCloseWS(ws: ServerWebSocket<unknown>, code: number, message: string) {
    let data = ws.data as any;
    let handler = this.wsCloseRoutes[data.path];
    if (handler) await handler(ws, code, message);
  }

  private async handleDrainWS(ws: ServerWebSocket<unknown>) {
    let data = ws.data as any;
    let handler = this.wsDrainRoutes[data.path];
    if (handler) await handler(ws);
  }

  #setupAuth(auth: RouterCtorOpts["auth"]) {
    if (!auth) return;

    this.use(
      new Middleware(async (c, next) => {
        const session = await auth.getSession(c);
        if (session) {
          c.set("user", session.user);
          c.set("userId", session.user.id);
          c.set("userRole", session.user.role);
          c.set("session", session.session);
        }
        return await next();
      }),
    );
    this.get(auth.path, (c) => auth.handler(c.req));
    this.post(auth.path, (c) => auth.handler(c.req));
  }

  listen(port: number = 3000) {
    const server = Bun.serve({
      port: port,
      fetch: this.handleHTTP.bind(this),
      websocket: {
        open: this.handleOpenWS.bind(this),
        message: this.handleMessageWS.bind(this),
        close: this.handleCloseWS.bind(this),
        drain: this.handleDrainWS.bind(this),
      },
    });
    console.log(`🚀 Server running on: ${server.url}`);
  }
}
