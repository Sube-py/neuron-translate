"""API error types shared by the HTTP, validation and provider layers."""

from __future__ import annotations


class ApiError(Exception):
    """An error that is safe to render back to the caller."""

    code = "internal_error"
    status = 500

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        status: int | None = None,
        field: str | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.field = field
        if code is not None:
            self.code = code
        if status is not None:
            self.status = status

    def to_payload(self) -> dict[str, object]:
        error: dict[str, object] = {"code": self.code, "message": self.message}
        if self.field:
            error["field"] = self.field
        return {"error": error}


class ValidationError(ApiError):
    code = "invalid_request"
    status = 400


class AuthError(ApiError):
    code = "unauthorized"
    status = 401


class NotFoundError(ApiError):
    code = "not_found"
    status = 404


class PayloadTooLargeError(ApiError):
    code = "payload_too_large"
    status = 413


class ProviderError(ApiError):
    """The upstream model call failed or returned something unusable."""

    code = "upstream_error"
    status = 502
