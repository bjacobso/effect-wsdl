export interface Name {
  readonly namespace: string;
  readonly local: string;
}
export interface Location {
  readonly source: string;
  readonly line: number;
  readonly column: number;
}
export interface Diagnostic {
  readonly code: string;
  readonly message: string;
  readonly location: Location;
}
export const expanded = (name: Name): string => `{${name.namespace}}${name.local}`;
export type Primitive =
  | "string"
  | "boolean"
  | "byte"
  | "short"
  | "int"
  | "unsignedByte"
  | "unsignedShort"
  | "unsignedInt"
  | "integer"
  | "long"
  | "unsignedLong"
  | "decimal"
  | "float"
  | "double"
  | "date"
  | "dateTime"
  | "time"
  | "base64Binary";
export interface Element extends Name {
  readonly type: string;
  readonly min: number;
  readonly max: number | "unbounded";
  readonly nillable: boolean;
}
export interface Attribute extends Name {
  readonly type: string;
  readonly required: boolean;
}
export type Type =
  | {
      readonly kind: "primitive";
      readonly primitive: Primitive;
      readonly enumeration?: readonly string[];
    }
  | {
      readonly kind: "complex";
      readonly elements: readonly Element[];
      readonly attributes: readonly Attribute[];
    };
export interface Operation {
  readonly name: string;
  readonly action: string;
  readonly input: Element;
  readonly output: Element;
  readonly faults: readonly { readonly name: string; readonly element: Element }[];
}
export interface Port {
  readonly service: string;
  readonly name: string;
  readonly endpoint: string;
  readonly operations: readonly Operation[];
  readonly diagnostics: readonly Diagnostic[];
}
export interface Contract {
  readonly ports: readonly Port[];
  readonly types: Readonly<Record<string, Type>>;
  readonly sources: readonly { readonly id: string; readonly hash: string }[];
}
export interface Generated {
  readonly files: Readonly<Record<string, string>>;
}
