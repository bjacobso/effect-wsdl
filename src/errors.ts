import { Data } from "effect";
import type { Location } from "./model/index.js";
export class ResourceError extends Data.TaggedError("ResourceError")<{
  readonly message: string;
}> {}
export class XmlParseError extends Data.TaggedError("XmlParseError")<{
  readonly message: string;
  readonly location: Location;
}> {}
export class ResolutionError extends Data.TaggedError("ResolutionError")<{
  readonly message: string;
  readonly location: Location;
}> {}
export class UnsupportedFeatureError extends Data.TaggedError("UnsupportedFeatureError")<{
  readonly message: string;
  readonly location: Location;
}> {}
export class GenerationError extends Data.TaggedError("GenerationError")<{
  readonly message: string;
}> {}
export type ContractError =
  | ResourceError
  | XmlParseError
  | ResolutionError
  | UnsupportedFeatureError;
