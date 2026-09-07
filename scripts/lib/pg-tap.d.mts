/** Types for the `pg` driver stand-in. See pg-tap.mjs. */
export interface RecordedStatement {
  sql: string;
  params: unknown[];
}
export declare const RECORDED: RecordedStatement[];
export declare function reset(): void;
declare const pg: unknown;
export default pg;
