/**
 * Liveness probe for the ALB target group.
 *
 * DELIBERATELY SHALLOW: returns 200 without touching the database.
 *
 * A deep check (`SELECT 1`) looks more useful and is a trap here. On a cold
 * start this app creates its schema (`migrate()` in src/lib/db.ts) and then
 * seeds itself (`ensureDemoData`, reached from src/app/login/page.tsx). A deep
 * check can fail during that window, ECS replaces the task doing the seeding,
 * and the replacement starts the same slow work again — forever.
 *
 * The accepted cost: a task whose database is unreachable reports healthy and
 * serves broken pages rather than being replaced. At demo scale that is visible
 * immediately and fixable by hand.
 */
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ status: "ok" });
}
