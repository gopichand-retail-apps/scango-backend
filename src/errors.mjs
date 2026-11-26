export class CheckoutError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = "CheckoutError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
