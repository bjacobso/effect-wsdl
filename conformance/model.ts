import type { Contract } from "../src/model/index.js";

export interface Case {
  readonly id: string;
  readonly area: string;
  readonly title: string;
  readonly reference: string;
  readonly validity: "valid" | "invalid" | "not-applicable";
  readonly source?: string;
  readonly resources?: Readonly<Record<string, string>>;
  readonly port?: string;
  readonly verify?: (contract: Contract) => void;
  readonly evidence?: string;
  readonly untested?: string;
}
export interface Phase {
  readonly status: "pass" | "unsupported" | "rejected" | "failed" | "not-run";
  readonly detail: string;
}
export type Outcome =
  | "demonstrated"
  | "accepted-unverified"
  | "unsupported"
  | "rejected-valid"
  | "invalid-rejected"
  | "invalid-accepted"
  | "invalid-blocked"
  | "failed"
  | "untested";
export interface Result {
  readonly id: string;
  readonly area: string;
  readonly title: string;
  readonly reference: string;
  readonly validity: Case["validity"];
  readonly outcome: Outcome;
  readonly evidence: string;
  readonly phases: Readonly<
    Record<"load" | "generate" | "runtime" | "httpApi" | "behavior", Phase>
  >;
}
