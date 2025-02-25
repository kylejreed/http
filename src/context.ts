import { z, ZodSchema } from "zod";
import { SystemErr, SystemErrCode } from "./errors";
import { MutResponse, type CookieOptions } from "./types";

export class WSContext {
  headers?: HeadersInit;
  data: Record<string, any>;
  constructor(req: Request, path: string) {
    this.headers = req.headers;
    this.data = {
      req,
      path,
    };
  }
  get(key: string) {
    return this.data[key];
  }
  set(key: string, value: any) {
    this.data[key] = value;
  }
}

export type BodyType = "json" | "text" | "form" | "multipart_form";

export class Context {
  req: Request;
  res: MutResponse;
  url: URL;
  path: string;
  method: string;
  route: string;
  segments: string[];
  params: Record<string, string>;
  private _body?: string | Record<string, any> | FormData;
  private _state: Record<string, any>;
  private err: Error | undefined | string;

  constructor(req: Request, params: Record<string, string> = {}) {
    this.req = req;
    this.res = new MutResponse();
    this.url = new URL(this.req.url);
    this.path = this.url.pathname.replace(/\/+$/, "") || "/";
    this.method = this.req.method;
    this.route = `${this.method} ${this.path}`;
    this.segments = this.path.split("/").filter(Boolean);
    this.params = params;
    this._state = {};
  }

  setErr(err: Error | undefined | string) {
    this.err = err;
  }

  getErr(): Error | undefined | string {
    return this.err;
  }

  assert(bool: boolean, err: Error) {
    if (!bool) {
      this.setErr(err);
      throw err;
    }
  }

  redirect(location: string, status: number = 302): Response {
    this.res.setStatus(status);
    this.res.setHeader("Location", location);
    return this.res.send();
  }

  async body<Schema extends ZodSchema>(as: "json", schemaFn?: Schema | ((zod: typeof z) => Schema)): Promise<Schema extends ZodSchema ? z.infer<Schema> : Record<string, any>>;
  async body(as: "form"): Promise<Record<string, string>>;
  async body(as: "multipart_form"): Promise<FormData>;
  async body(as: "text"): Promise<string>;
  async body<T extends BodyType>(as: T, arg?: any): Promise<any> {
    if (this._body !== undefined) {
      return this._body as any;
    }

    const contentType = this.req.headers.get("Content-Type") || "";

    let parsedData: any;

    if (contentType.includes("application/json")) {
      if (as !== "json") {
        throw new SystemErr(SystemErrCode.BODY_PARSING_FAILED, "Unexpected JSON data");
      }
      try {
        parsedData = await this.req.json();
        if (arg instanceof ZodSchema) {
          parsedData = arg.parse(parsedData);
        } else if (typeof arg === "function") {
          parsedData = arg(z).parse(parsedData);
        }
      } catch (err: any) {
        throw new SystemErr(SystemErrCode.BODY_PARSING_FAILED, `JSON parsing failed: ${err.message}`);
      }
    } else if (contentType.includes("application/x-www-form-urlencoded")) {
      if (as !== "form") {
        throw new SystemErr(SystemErrCode.BODY_PARSING_FAILED, "Unexpected FORM data");
      }
      parsedData = Object.fromEntries(new URLSearchParams(await this.req.text()));
    } else if (contentType.includes("multipart/form-data")) {
      if (as !== "multipart_form") {
        throw new SystemErr(SystemErrCode.BODY_PARSING_FAILED, "Unexpected MULTIPART_FORM data");
      }
      parsedData = await this.req.formData();
    } else {
      if (as !== "text") {
        throw new SystemErr(SystemErrCode.BODY_PARSING_FAILED, "Unexpected TEXT data");
      }
      parsedData = await this.req.text();
    }

    this._body = parsedData;
    return parsedData;
  }

  param(name: string): string {
    return this.params[name];
  }

  status(code: number): this {
    this.res.setStatus(code);
    return this;
  }

  header(name: string): string | null;
  header(name: string, value: string): this;
  header(name: string, value?: string): this | string | null {
    if (value) {
      this.res.setHeader(name, value);
      return this;
    }
    return this.req.headers.get(name);
  }

  private send(content: string): Response {
    return this.res.body(content).send();
  }

  html(content: string): Response {
    this.header("Content-Type", "text/html");
    return this.send(content);
  }

  text(content: string): Response {
    this.header("Content-Type", "text/plain");
    return this.send(content);
  }

  json(data: any): Response {
    this.header("Content-Type", "application/json");
    return this.send(JSON.stringify(data));
  }

  async stream(stream: ReadableStream): Promise<Response> {
    this.header("Content-Type", "application/octet-stream");
    return new Response(stream, {
      status: this.res.statusCode,
      headers: this.res.headers,
    });
  }

  async file(path: string, stream = false): Promise<Response> {
    let file = Bun.file(path);
    let exists = await file.exists();
    if (!exists) {
      throw new SystemErr(SystemErrCode.FILE_NOT_FOUND, `file does not exist at ${path}`);
    }
    this.res.setHeader("Content-Type", file.type || "application/octet-stream");
    return stream
      ? new Response(file.stream(), {
          status: this.res.statusCode,
          headers: this.res.headers,
        })
      : new Response(file, {
          status: this.res.statusCode,
          headers: this.res.headers,
        });
  }

  set<T>(key: string, value: T): T | void {
    this._state[key] = value;
  }

  get<T = any>(key: string): T {
    return this._state[key] as T;
  }

  query(name: string, defaultValue: string = ""): string {
    return this.url.searchParams.get(name) ?? defaultValue;
  }

  getCookie(name: string): string | undefined {
    const cookies = this.req.headers.get("Cookie");
    if (!cookies) return undefined;
    return cookies
      .split("; ")
      .map((c) => c.split(/=(.*)/s, 2)) // Preserve `=` inside values
      .reduce<Record<string, string>>((acc, [key, val]) => {
        acc[key] = val;
        return acc;
      }, {})[name];
  }

  setCookie(name: string, value: string, options: CookieOptions = {}) {
    let cookieString = `${name}=${encodeURIComponent(value)}`;
    options.path ??= "/";
    options.httpOnly ??= true;
    options.secure ??= true;
    options.sameSite ??= "Lax";
    if (options.domain) cookieString += `; Domain=${options.domain}`;
    if (options.maxAge !== undefined) {
      cookieString += `; Max-Age=${options.maxAge}`;
    }
    if (options.expires) {
      cookieString += `; Expires=${options.expires.toUTCString()}`;
    }
    if (options.httpOnly) cookieString += `; HttpOnly`;
    if (options.secure) cookieString += `; Secure`;
    if (options.sameSite) cookieString += `; SameSite=${options.sameSite}`;
    this.res.headers.append("Set-Cookie", cookieString);
  }

  clearCookie(name: string, path: string = "/", domain?: string): void {
    this.setCookie(name, "", {
      path,
      domain,
      maxAge: 0,
      expires: new Date(0), // Ensure proper removal
    });
  }
}
