# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""API errors: the HTTP status and { code, message } (API.md, Conventions)."""


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str = "", details: list | None = None, headers: dict | None = None):
        super().__init__(message or code)
        self.status = status
        self.code = code
        self.message = message or code.replace("_", " ")
        self.details = details
        self.headers = headers

    def body(self) -> dict:
        body = {"code": self.code, "message": self.message}
        if self.details:
            body["details"] = self.details
        return body


def bad_request(message="", details=None):
    return ApiError(400, "bad_request", message, details)


def forbidden(message="", code="forbidden"):
    return ApiError(403, code, message)


def not_found(message="not found"):
    return ApiError(404, "not_found", message)


def conflict(message="", code="conflict"):
    return ApiError(409, code, message)


def rate_limited(retry_after: int):
    return ApiError(429, "rate_limited", "too many requests", headers={"Retry-After": str(retry_after)})
