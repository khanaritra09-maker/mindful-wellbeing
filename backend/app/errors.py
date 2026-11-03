from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
import logging

logger = logging.getLogger("mindful.errors")


def _error(code: str, message: str, status_code: int, errors=None):
    detail = {"code": code, "message": message}
    if errors is not None:
        detail["errors"] = errors
    return JSONResponse(status_code=status_code, content={"detail": detail})


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError):
        errors = [{"field": ".".join(str(part) for part in item["loc"]), "message": "Invalid value."} for item in exc.errors()]
        return _error("validation_error", "The request did not pass validation.", 422, errors)

    @app.exception_handler(HTTPException)
    async def http_error(_: Request, exc: HTTPException):
        if isinstance(exc.detail, dict) and "code" in exc.detail:
            return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail}, headers=exc.headers)
        return _error("request_error", str(exc.detail), exc.status_code)

    @app.exception_handler(Exception)
    async def unhandled_error(request: Request, _: Exception):
        logger.error("Unhandled request failure request_id=%s", getattr(request.state, "request_id", "unknown"))
        return _error("internal_error", "The request could not be completed.", 500)
