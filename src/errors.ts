export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message?: string,
  ) {
    super(message);
  }
}

export const Errors = {
  BadRequest: (msg?: string) => new HttpError(400, msg),
  Unauthorized: (msg?: string) => new HttpError(401, msg),
  Forbidden: (msg?: string) => new HttpError(403, msg),
  NotFound: () => new HttpError(404),
};

export enum SystemErrCode {
  FILE_NOT_FOUND = "FILE_NOT_FOUND",
  BODY_PARSING_FAILED = "BODY_PARSING_FAILED",
  ROUTE_ALREADY_REGISTERED = "ROUTE_ALREADY_REGISTERED",
  ROUTE_NOT_FOUND = "ROUTE_NOT_FOUND",
  INTERNAL_SERVER_ERR = "INTERNAL SERVER ERROR",
  WEBSOCKET_UPGRADE_FAILURE = "WEBSOCKET UPGRADE FAILURE",
}

export class SystemErr extends Error {
  typeOf: SystemErrCode;
  constructor(typeOf: SystemErrCode, message: string) {
    super(`${typeOf}: ${message}`);
    this.typeOf = typeOf;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, SystemErr);
    }
  }
}
