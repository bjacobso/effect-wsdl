import { Data } from "effect";
export class ClientConstructionError extends Data.TaggedError("ClientConstructionError")<{
  readonly message: string;
}> {}
export class UnknownOperationError extends Data.TaggedError("UnknownOperationError")<{
  readonly operation: string;
}> {}
export class InputValidationError extends Data.TaggedError("InputValidationError")<{
  readonly message: string;
  readonly operation: string;
}> {}
export class TransportError extends Data.TaggedError("TransportError")<{
  readonly message: string;
  readonly operation: string;
}> {}
export class TimeoutError extends Data.TaggedError("TimeoutError")<{
  readonly message: string;
  readonly operation: string;
}> {}
export class HttpStatusError extends Data.TaggedError("HttpStatusError")<{
  readonly status: number;
  readonly operation: string;
}> {}
export class ResponseDecodeError extends Data.TaggedError("ResponseDecodeError")<{
  readonly message: string;
  readonly operation: string;
}> {}
export class SoapFault<D = never> extends Data.TaggedError("SoapFault")<{
  readonly operation: string;
  readonly code: string;
  readonly message: string;
  readonly detail: D | { readonly _tag: "UnknownFault"; readonly xmlName: string | null };
}> {}
export type OperationError<D = never> =
  | InputValidationError
  | TransportError
  | TimeoutError
  | HttpStatusError
  | ResponseDecodeError
  | SoapFault<D>;
