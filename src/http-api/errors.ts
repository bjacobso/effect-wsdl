import { Schema } from "effect";

export const BadRequest = Schema.Struct({
  _tag: Schema.Literal("WsdlBadRequest"),
  message: Schema.String,
});
export const PayloadTooLarge = Schema.Struct({
  _tag: Schema.Literal("WsdlPayloadTooLarge"),
  message: Schema.String,
});
export const RequestTimeout = Schema.Struct({
  _tag: Schema.Literal("WsdlRequestTimeout"),
  message: Schema.String,
});
export const UnsupportedMediaType = Schema.Struct({
  _tag: Schema.Literal("WsdlUnsupportedMediaType"),
  message: Schema.String,
});
export const UpstreamError = Schema.Struct({
  _tag: Schema.Literal("WsdlUpstreamError"),
  operation: Schema.String,
  message: Schema.String,
});
export const UpstreamTimeout = Schema.Struct({
  _tag: Schema.Literal("WsdlUpstreamTimeout"),
  operation: Schema.String,
  message: Schema.String,
});
export interface GatewayFault {
  readonly _tag: "WsdlSoapFault";
  readonly operation: string;
  readonly code: string;
  readonly message: string;
  readonly detail: unknown;
}
export type GatewayError =
  | typeof BadRequest.Type
  | typeof PayloadTooLarge.Type
  | typeof RequestTimeout.Type
  | typeof UnsupportedMediaType.Type
  | typeof UpstreamError.Type
  | typeof UpstreamTimeout.Type
  | GatewayFault;
