/**
 * ApiError
 * ────────
 * Error tipe-aman dengan HTTP status code untuk dilempar dari controller/service.
 * Akan ditangkap oleh `errorHandler` dan dikonversi jadi JSON response.
 *
 * @example
 *   throw ApiError.notFound("Pasien tidak ditemukan");
 *   throw ApiError.badRequest("Email sudah dipakai", { field: "email" });
 */
export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly details?: unknown;

  constructor(statusCode: number, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.details = details;
    Object.setPrototypeOf(this, ApiError.prototype);
  }

  static badRequest(message = "Bad Request", details?: unknown) {
    return new ApiError(400, message, details);
  }

  static unauthorized(message = "Unauthorized") {
    return new ApiError(401, message);
  }

  static forbidden(message = "Forbidden") {
    return new ApiError(403, message);
  }

  static notFound(message = "Not Found") {
    return new ApiError(404, message);
  }

  static conflict(message = "Conflict", details?: unknown) {
    return new ApiError(409, message, details);
  }

  static unprocessable(message = "Unprocessable Entity", details?: unknown) {
    return new ApiError(422, message, details);
  }

  static internal(message = "Internal Server Error", details?: unknown) {
    return new ApiError(500, message, details);
  }
}
