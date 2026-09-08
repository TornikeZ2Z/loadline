"use client";

/**
 * The admin console, and it opens on the queue rather than on a dashboard.
 *
 * The premise of the extractor is that an unknown format is solved once and
 * stays solved: a message the rules could not read lands in Needs attention
 * with a per-line colour gutter, an admin fixes the one line that broke it, and
 * the fix is stored as a rule, re-runs the message and every recent message
 * from that sender, and is exported into the eval fixtures so it cannot
 * regress. This screen is where that loop is closed, so it is the front door.
 *
 * Saving a rule does NOT call the reprocess endpoint: A's rules and formats
 * routes already reprocess server-side and return the count, and calling both
 * would double the work and race. The Reprocess button is the only caller.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/basePath";
import type { CronStatus } from "@/lib/cron/runs";
import type { ChatGroup, ChatLoad, ChatMessage } from "@/lib/demo/chats";
import type { LineAudit, LineClass } from "@/lib/extract/schema";
import type { IgnoreLineRule, KeywordAs } from "@/lib/extract/rules-store";
import type { HereStatus, ZipSurvey, ZipWarmResult } from "@/lib/geo/zips";
import { formatCf } from "@/lib/loads/present";
import { reportReasonLabel, type ProblemReport } from "@/lib/reports";
import { LocationInput, type ResolvedPlace } from "./LocationInput";
import { Chip } from "./ui";

export type AdminTab = "attention" | "try" | "messages" | "senders" | "rules" | "groups" | "map";

export interface AdminConsoleProps {
  groups: ChatGroup[];
  initialTab?: AdminTab;
  initialMessageId?: number | null;
}

const TABS: Array<[AdminTab, string]> = [
  ["attention", "Needs attention"],
  ["try", "Try a message"],
  ["messages", "Messages"],
  ["senders", "Senders"],
  ["rules", "Rules"],
  ["groups", "Groups"],
  ["map", "Map precision"],
];

/** Exactly the attention codes the pipeline can set. */
const ATTENTION_CODES = [
  "unknown_format",
  "no_origin",
  "origin_unresolved",
  "unknown_lines",
  "new_format",
  "truncated",
  "state_header_ambiguous",
  "needs_review",
  "no_contact",
] as const;

const IGNORE_AS: IgnoreLineRule["as"][] = [
  "chatter",
  "requirement",
  "title",
  "decoration",
  "contact",
];

const KEYWORD_AS: KeywordAs[] = ["CF_UNIT", "RFD", "TO", "FROM", "PERCF", "NOTE"];

/** The nine placeholders a taught line may use. */
const PLACEHOLDERS = ["{CF}", "{ST}", "{ZIP}", "{CITY}", "{PRICE}", "{DATE}", "{RFD}", "{NOTES}", "{WORD}"];

const LINE_CLASS: Record<LineClass, string> = {
  HEADER: "l-header",
  TITLE: "l-header",
  DESTINATION: "l-dest",
  LANE: "l-dest",
  CONTINUATION: "l-dest",
  CONTACT: "l-contact",
  CONTACT_NAME: "l-contact",
  REQUIREMENT: "l-req",
  CHATTER: "",
  FOOTER_FLAG: "",
  NOTE: "",
  DECORATION: "",
  BLANK: "",
  READMORE: "",
  UNKNOWN: "l-unknown",
};

/** The six real formats, trimmed to the smallest piece that still parses. */
const EXAMPLES: Array<{ label: string; text: string }> = [
  {
    label: "A · header + bare numbers",
    text: `🚚Ready for Delivery From California 🚚

🏙FROM Los Angeles🏙

NY 11217              200
WV 25276      1000
MI 48118            350`,
  },
  {
    label: "B · From / To pairs",
    text: `From Grand Junction
To  FL 33435 350cf
To  MA 02072 500cf

From Cortez CO 81321
To NM 87825 250cf

All jobs are ready for delivery`,
  },
  {
    label: "C · cf first, RFD",
    text: `NEW JERSEY
📍 Kearny
400cf MI  48864 RFD
200cf FL 33180 RFD
500cf SC 29588 RFD

✅ Must have active DOT & MC`,
  },
  {
    label: "D · c/f-ZIP with dates",
    text: `🇺🇸 💰 From:Woodburn ,OR 💰
To:KY 400 c/f-40741 RFD 9/9
To:NC 300 c/f-28463
To:TN 800 c/f-37040 RFD 9/8`,
  },
  {
    label: "E · cf. dest $per-cf",
    text: `FROM AUBURN CA
2000.    FL 32439 $3.75 Bulky URGET ranger
300.      MS 39759 $3.5`,
  },
  {
    label: "F · unknown format",
    text: `33435/350, 33180/200`,
  },
];

// --- a tiny fetch helper -----------------------------------------------------

interface Fetched<T> {
  data: T | null;
  /** The route is not deployed yet (A's admin API lands in its own commit). */
  unavailable: boolean;
  error: string | null;
  loading: boolean;
}

async function getJson<T>(path: string): Promise<Fetched<T>> {
  try {
    const res = await fetch(api(path));
    if (res.status === 404) return { data: null, unavailable: true, error: null, loading: false };
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      return { data: null, unavailable: false, error: body?.error ?? res.statusText, loading: false };
    }
    return { data: body as T, unavailable: false, error: null, loading: false };
  } catch (e) {
    return {
      data: null,
      unavailable: false,
      error: e instanceof Error ? e.message : "Request failed",
      loading: false,
    };
  }
}

function useAdminResource<T>(path: string | null): Fetched<T> & { reload(): void } {
  const [state, setState] = useState<Fetched<T>>({
    data: null,
    unavailable: false,
    error: null,
    loading: true,
  });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!path) return;
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    void getJson<T>(path).then((r) => alive && setState(r));
    return () => {
      alive = false;
    };
  }, [path, tick]);

  return { ...state, reload: () => setTick((t) => t + 1) };
}

function Unavailable({ what }: { what: string }) {
  return (
    <p className="text-(length:--fs-base)" style={{ color: "var(--muted)" }}>
      {what} is not available yet.
    </p>
  );
}

// --- the console -------------------------------------------------------------

export function AdminConsole({ groups, initialTab, initialMessageId }: AdminConsoleProps) {
  const [tab, setTab] = useState<AdminTab>(initialTab ?? "attention");
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  return (
    <div className="mx-auto max-w-[1400px] p-[var(--sp-4)] md:p-[var(--sp-5)]">
      {/* Site settings is a link beside the title, not an eighth tab. Every tab
          below is a view of the corpus and is opened weekly; that page is opened
          about twice in the life of the company and rewrites what six PUBLIC
          pages assert about who runs the site. Filing it under the corpus views
          would say the two are the same kind of work. */}
      <div className="flex flex-wrap items-baseline justify-between gap-[var(--sp-2)]">
        <h1 className="big text-(length:--fs-xl)">Extraction admin</h1>
        <Link
          href="/admin/settings"
          className="font-semibold text-(length:--fs-base)"
          style={{ color: "var(--accent)" }}
        >
          Site settings →
        </Link>
      </div>
      <p className="mt-[var(--sp-1)] text-(length:--fs-base)" style={{ color: "var(--muted)" }}>
        Everything on the board is derived from the raw messages, so a message can always be replayed
        after a rule changes — and a fix saved here survives a database reset.
      </p>

      <CronRuns />

      {/* Six tabs need 494 px and a phone has 390, so the row scrolls sideways
          rather than the page: the whole console was 26 % wider than the screen
          and every panel below drifted left as you reached the last tab. */}
      <div className="-mx-[var(--sp-4)] mt-[var(--sp-4)] flex gap-[var(--sp-1)] overflow-x-auto border-b border-border px-[var(--sp-4)] [scrollbar-width:none] md:mx-0 md:px-0 [&::-webkit-scrollbar]:hidden">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className="min-h-[var(--tap-min)] shrink-0 whitespace-nowrap px-[var(--sp-3)] py-[var(--sp-2)] text-(length:--fs-base) font-semibold"
            style={
              tab === key
                ? { color: "var(--accent)", borderBottom: "2px solid var(--accent)" }
                : { color: "var(--muted)" }
            }
          >
            {label}
          </button>
        ))}
      </div>

      {toast && (
        <p
          className="mt-[var(--sp-3)] rounded-[var(--radius-sm)] px-[var(--sp-3)] py-[var(--sp-2)] text-(length:--fs-base)"
          style={{ background: "var(--ok-soft)", color: "var(--ok)" }}
        >
          {toast}
        </p>
      )}

      <div className="mt-[var(--sp-4)]">
        {tab === "attention" && <Attention initialMessageId={initialMessageId} onToast={setToast} />}
        {tab === "try" && <TryMessage />}
        {tab === "messages" && <MessageFeed />}
        {tab === "senders" && <Senders onToast={setToast} />}
        {tab === "rules" && <Rules onToast={setToast} />}
        {tab === "groups" && <Groups groups={groups} onToast={setToast} />}
        {tab === "map" && <MapPrecision onToast={setToast} />}
      </div>
    </div>
  );
}

/* -------------------------------- cron runs ------------------------------- */

/**
 * Did the sweeps run?
 *
 * A strip above the tabs rather than an eighth tab, because the answer is never
 * the thing an admin came here for and is always the thing that invalidates
 * every other tab if it is wrong. A silent expiry sweep does not look like a
 * broken expiry sweep: it looks like a board full of jobs, which is what the
 * board is supposed to look like. There is no other way to notice from here —
 * the alternative is a CloudWatch log group, an AWS console and a role.
 *
 * WHEN IT SAYS NOTHING IT SHOWS NOTHING. If `/api/cron/status` 404s — an older
 * image, this feature not deployed yet — the strip renders as absent rather
 * than as an error, because a console that shouts about a route it cannot find
 * teaches an admin to ignore the strip.
 */
const SWEEP_LABEL: Record<string, string> = {
  process: "WhatsApp queue",
  expire: "Expiry",
  match: "Matching",
};

/** Coarse on purpose: nobody needs "3 minutes and 12 seconds ago". */
function ago(iso: string | null, nowMs: number): string {
  if (!iso) return "never";
  const ms = nowMs - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function cadence(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

/**
 * The counters of the last completed run, zeros dropped.
 *
 * "nothing to do" and not "0 processed, 0 created, 0 duplicates": a run that
 * found nothing is the normal state of a board with no WhatsApp number
 * connected, and eight zeros in a row reads like a fault.
 */
function countsLine(counts: Record<string, number> | null | undefined): string {
  if (!counts) return "";
  const live = Object.entries(counts).filter(([, v]) => typeof v === "number" && v > 0);
  if (!live.length) return "nothing to do";
  return live.map(([k, v]) => `${k} ${v}`).join(" · ");
}

function CronRuns() {
  const { data, unavailable, error, reload } = useAdminResource<CronStatus>("/api/cron/status");

  // The strip is read while it is watched — an admin who has just turned the
  // scheduler on wants to see the first tick land without reloading the page.
  useEffect(() => {
    const timer = setInterval(reload, 60_000);
    return () => clearInterval(timer);
    // `reload` closes over a stable setState, so a stale closure still works.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (unavailable || !data) {
    return error ? (
      <p className="mt-[var(--sp-2)] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
        Scheduled sweeps: {error}
      </p>
    ) : null;
  }

  const nowMs = new Date(data.now).getTime();

  return (
    <div
      className="mt-[var(--sp-3)] rounded-[var(--radius-sm)] border border-border p-[var(--sp-3)]"
      style={{ background: "var(--surface-2)" }}
    >
      <div className="flex flex-wrap items-baseline gap-x-[var(--sp-2)] gap-y-[var(--sp-1)]">
        <span className="font-semibold text-(length:--fs-sm)">Scheduled sweeps</span>
        <span className="text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
          {data.enabled
            ? `running in this process · ${data.reason}`
            : `not scheduled in this process · ${data.reason}`}
        </span>
      </div>

      <ul className="mt-[var(--sp-2)] flex flex-col gap-[var(--sp-1)]">
        {data.sweeps.map((s) => {
          // "Never run" is only alarming where something was supposed to run.
          // On a laptop with the scheduler off it is simply the truth.
          const quiet = !data.enabled && !s.lastOk;
          const bad = !quiet && s.stale;
          const last = s.last;
          return (
            <li
              key={s.sweep}
              className="flex flex-wrap items-baseline gap-x-[var(--sp-2)] text-(length:--fs-sm)"
              style={bad ? { color: "var(--danger)" } : undefined}
            >
              <span className="min-w-[8.5rem] font-semibold">{SWEEP_LABEL[s.sweep] ?? s.sweep}</span>
              <span style={bad ? undefined : { color: "var(--muted)" }}>every {cadence(s.intervalMs)}</span>
              <span>
                {s.lastOk ? `finished ${ago(s.lastOk.finished_at, nowMs)}` : "never completed"}
              </span>
              {s.lastOk && (
                <span style={bad ? undefined : { color: "var(--muted)" }}>
                  {countsLine(s.lastOk.counts)}
                </span>
              )}
              {/* The last run and the last SUCCESSFUL run are different rows the
                  moment anything goes wrong, and the difference is the news. */}
              {last && last.status !== "ok" && (
                <span style={{ color: last.status === "error" ? "var(--danger)" : "var(--muted)" }}>
                  last attempt {ago(last.started_at, nowMs)}: {last.status}
                  {last.detail ? ` — ${last.detail}` : ""}
                </span>
              )}
              {bad && (
                <span className="font-semibold">
                  no completed run in over twice its {cadence(s.intervalMs)} cadence
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ----------------------------- needs attention ---------------------------- */

type QueueMessage = ChatMessage & { processed_at: string | null; attempts: number };

/**
 * What is currently open in the right-hand pane.
 *
 * A union rather than two ids, because the two are mutually exclusive by
 * definition: this queue shows one thing at a time, and a state that could hold
 * both would have to decide which wins on every render.
 */
type QueueSelection = { kind: "message"; id: number } | { kind: "report"; id: number };

/**
 * The one chip that filters to reported jobs.
 *
 * It sits in the same row as the parser's attention codes, and it is lowercase
 * like they are, because to an admin it is the same kind of fact: something
 * about this job needs a human. It is not an attention code — no pipeline
 * writes it — which is why it is a constant here rather than an entry in
 * ATTENTION_CODES, where it would eventually be sent to the messages endpoint
 * as `?attention=reported` and match nothing.
 */
const REPORTED = "reported";

/** 500 characters is fine in the pane; in a 380 px card it is the whole column. */
function preview(text: string, max = 110): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`;
}

/**
 * Needs attention: messages the parser could not read, AND jobs somebody
 * reported.
 *
 * One queue, deliberately. An admin's attention is a single thing, and a job a
 * driver says is wrong belongs next to a message the rules choked on — they are
 * both "the board is lying about something, go look". Two tabs would have made
 * the second one the tab nobody opens.
 *
 * Reports lead the list when no filter is set, because they are the only rows
 * here a person outside the company took the trouble to write.
 */
function Attention({
  initialMessageId,
  onToast,
}: {
  initialMessageId?: number | null;
  onToast(text: string): void;
}) {
  const [code, setCode] = useState<string>("");
  const [sender, setSender] = useState("");
  const [selected, setSelected] = useState<QueueSelection | null>(
    initialMessageId == null ? null : { kind: "message", id: initialMessageId },
  );

  // A specific attention code is a question about the parser, and no report
  // carries one, so asking for messages at all would be asking for nothing.
  const showReports = code === "" || code === REPORTED;
  const showMessages = code !== REPORTED;

  const path = showMessages
    ? `/api/admin/messages?${new URLSearchParams({
        ...(code ? { attention: code } : {}),
        ...(sender ? { sender } : {}),
        limit: "100",
      })}`
    : null;
  const queue = useAdminResource<{ messages: QueueMessage[] }>(path);

  // Always fetched, whatever the filter says, so the `reported` chip can carry a
  // count: a queue that hides how much is in it is a queue nobody checks.
  const reportsRes = useAdminResource<{ reports: ProblemReport[] }>(
    "/api/admin/reports?status=open&limit=100",
  );

  const messages = showMessages ? (queue.data?.messages ?? []) : [];
  const allReports = reportsRes.data?.reports ?? [];
  const reports = showReports ? allReports : [];

  const loading = (showMessages && queue.loading) || reportsRes.loading;
  const empty = !loading && messages.length === 0 && reports.length === 0;

  return (
    <div className="grid gap-[var(--sp-4)] lg:grid-cols-[380px_1fr]">
      <div>
        <div className="flex flex-wrap gap-[var(--sp-1)]">
          <FilterChip on={code === ""} onClick={() => setCode("")}>
            any
          </FilterChip>
          <FilterChip on={code === REPORTED} onClick={() => setCode(REPORTED)}>
            {allReports.length > 0 ? `${REPORTED} (${allReports.length})` : REPORTED}
          </FilterChip>
          {ATTENTION_CODES.map((c) => (
            <FilterChip key={c} on={code === c} onClick={() => setCode(c)}>
              {c}
            </FilterChip>
          ))}
        </div>

        <input
          className="field mt-[var(--sp-2)]"
          placeholder="Filter by sender key"
          value={sender}
          // A sender key belongs to a message; a report is filed against a job
          // and carries none. Typing one is a question only messages can answer.
          disabled={code === REPORTED}
          onChange={(e) => setSender(e.target.value)}
        />

        <div className="mt-[var(--sp-3)] flex flex-col gap-[var(--sp-2)]">
          {queue.unavailable && reportsRes.unavailable ? (
            <Unavailable what="The attention queue" />
          ) : loading ? (
            <p style={{ color: "var(--muted)" }}>Loading…</p>
          ) : empty ? (
            <p style={{ color: "var(--muted)" }}>Nothing needs attention.</p>
          ) : (
            <>
              {reports.map((r) => {
                const on = selected?.kind === "report" && selected.id === r.id;
                return (
                  <button
                    key={`report-${r.id}`}
                    className={`card p-[var(--sp-2)] text-left${on ? " card-selected" : ""}`}
                    onClick={() => setSelected({ kind: "report", id: r.id })}
                  >
                    <div className="flex flex-wrap items-center gap-[var(--sp-1)]">
                      <span className="font-semibold">Job {r.load_id}</span>
                      {/* The job's own words when it still exists, and nothing
                          at all when it does not -- never a placeholder that
                          reads like a place. */}
                      {r.pickup_label && r.delivery_label && (
                        <span className="text-(length:--fs-xs)" style={{ color: "var(--muted)" }}>
                          {r.pickup_label} → {r.delivery_label}
                        </span>
                      )}
                      <span className="ml-auto text-(length:--fs-xs)" style={{ color: "var(--muted)" }}>
                        {new Date(r.last_seen_at).toLocaleDateString()}
                      </span>
                    </div>
                    <div className="mt-[var(--sp-1)] flex flex-wrap gap-[var(--sp-1)]">
                      <Chip tone="review">{REPORTED}</Chip>
                      <Chip tone="warn">{reportReasonLabel(r.reason)}</Chip>
                      {r.occurrences > 1 && <Chip tone="muted">{r.occurrences}×</Chip>}
                      {r.pickup_label === null && <Chip tone="muted">job is gone</Chip>}
                    </div>
                    {r.details && (
                      <p
                        className="mt-[var(--sp-1)] [overflow-wrap:anywhere] text-(length:--fs-xs)"
                        style={{ color: "var(--muted)" }}
                      >
                        {preview(r.details)}
                      </p>
                    )}
                  </button>
                );
              })}

              {messages.map((m) => {
                const on = selected?.kind === "message" && selected.id === m.id;
                return (
                  <button
                    key={`message-${m.id}`}
                    className={`card p-[var(--sp-2)] text-left${on ? " card-selected" : ""}`}
                    onClick={() => setSelected({ kind: "message", id: m.id })}
                  >
                    <div className="flex flex-wrap items-center gap-[var(--sp-1)]">
                      <span className="font-semibold">{m.author_name ?? "Unknown"}</span>
                      {m.group_name && (
                        <span className="text-(length:--fs-xs)" style={{ color: "var(--muted)" }}>
                          {m.group_name}
                        </span>
                      )}
                      <span className="ml-auto text-(length:--fs-xs)" style={{ color: "var(--muted)" }}>
                        {new Date(m.sent_at).toLocaleDateString()}
                      </span>
                    </div>
                    <div className="mt-[var(--sp-1)] flex flex-wrap gap-[var(--sp-1)]">
                      {m.attention && <Chip tone="warn">{m.attention}</Chip>}
                      {m.parse_status && (
                        <Chip tone={m.parse_status === "clean" ? "ok" : "warn"}>{m.parse_status}</Chip>
                      )}
                      {m.snapshot_kind && <Chip tone="muted">{m.snapshot_kind}</Chip>}
                      <Chip tone="muted">{m.load_count} jobs</Chip>
                    </div>
                    {m.format_signature && (
                      <code className="mt-[var(--sp-1)] block text-(length:--fs-xs)" style={{ color: "var(--muted)" }}>
                        {m.format_signature}
                      </code>
                    )}
                  </button>
                );
              })}
            </>
          )}
        </div>
      </div>

      {selected == null ? (
        <p style={{ color: "var(--muted)" }}>Pick a message or a report to work on it.</p>
      ) : selected.kind === "report" ? (
        <ReportPanel
          report={allReports.find((r) => r.id === selected.id) ?? null}
          onToast={(t) => {
            onToast(t);
            reportsRes.reload();
            setSelected(null);
          }}
        />
      ) : (
        <MessageWorkbench
          messageId={selected.id}
          onToast={(t) => {
            onToast(t);
            queue.reload();
          }}
        />
      )}
    </div>
  );
}

/**
 * One reported job, and the two things an admin can do about it.
 *
 * RESOLVE means the job was wrong and has been dealt with; a fresh report about
 * the same job and reason reopens the row, because a problem that comes back is
 * news. DISMISS means the job is right and the report was not; POST /api/reports
 * leaves a dismissed row alone, so nobody can push it back into this queue by
 * clicking again. The wording of the two buttons has to carry that difference,
 * because the API's behaviour depends on which one is pressed.
 *
 * `details` is a stranger's free text. It is rendered as a text node and nothing
 * else -- not linked, not parsed, not trusted -- and it arrived stripped of
 * control and bidirectional characters and cut to 500 (src/lib/reports.ts).
 * `whitespace-pre-wrap` keeps their line breaks.
 *
 * `min-w-0` on the root and `overflow-wrap: anywhere` on the text are not
 * cosmetic, and `break-words` was not enough: a grid child defaults to
 * `min-width: auto`, so 500 characters with no space in them set this column's
 * minimum and pushed the WHOLE PAGE to 4170 px with a horizontal scrollbar --
 * a stranger's POST body reshaping an admin's screen. `anywhere` is the one
 * value that also shrinks the min-content size, which is what the grid reads.
 */
function ReportPanel({
  report,
  onToast,
}: {
  report: ProblemReport | null;
  onToast(text: string): void;
}) {
  const [busy, setBusy] = useState(false);

  if (!report) return <p style={{ color: "var(--muted)" }}>That report is no longer open.</p>;

  async function close(status: "resolved" | "dismissed") {
    if (!report) return;
    setBusy(true);
    try {
      const res = await fetch(api(`/api/admin/reports/${report.id}`), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (res.status === 404) {
        onToast("The reports endpoint is not available yet.");
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        onToast(body?.error ?? "Could not update the report");
        return;
      }
      onToast(status === "resolved" ? "Report resolved." : "Report dismissed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-[var(--sp-2)]">
        <span className="font-semibold">Job {report.load_id}</span>
        <Chip tone="review">{REPORTED}</Chip>
        <Chip tone="warn">{reportReasonLabel(report.reason)}</Chip>
        {report.occurrences > 1 && (
          <Chip tone="muted" title="Distinct reports of this job for this reason">
            {report.occurrences} reports
          </Chip>
        )}
        <button className="btn btn-sm" disabled={busy} onClick={() => close("resolved")}>
          Resolve
        </button>
        <button className="btn btn-sm" disabled={busy} onClick={() => close("dismissed")}>
          Dismiss
        </button>
      </div>

      <p className="mt-[var(--sp-2)] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
        {report.pickup_label && report.delivery_label ? (
          <>
            {report.pickup_label} → {report.delivery_label}
            {report.load_status ? ` · ${report.load_status}` : ""} ·{" "}
            {/* Link, not <a>: a hand-written href would miss the base path when
                the app is served under a sub-path (see src/lib/basePath.ts). */}
            <Link
              href={`/jobs/${report.load_id}`}
              target="_blank"
              className="font-semibold"
              style={{ color: "var(--accent)" }}
            >
              See it on the board →
            </Link>
          </>
        ) : (
          // Said, not hidden: the report outlives the job on purpose, and an
          // admin looking for a row that is not there should be told why.
          `Job ${report.load_id} is no longer in the database. The report is kept anyway.`
        )}
      </p>

      <p className="mt-[var(--sp-1)] text-(length:--fs-xs)" style={{ color: "var(--muted)" }}>
        First reported {new Date(report.first_seen_at).toLocaleString()} · last{" "}
        {new Date(report.last_seen_at).toLocaleString()} ·{" "}
        {/* "Not signed in" is the truth and the common case, and it is worth
            seeing: an anonymous report is the one we can least follow up on. */}
        {report.reporter_name
          ? `first filed by ${report.reporter_name} (${report.reporter_email})`
          : "filed by someone who was not signed in"}
      </p>

      {report.details ? (
        <div className="card mt-[var(--sp-3)] p-[var(--sp-3)]">
          <div className="mb-[var(--sp-1)] text-(length:--fs-xs)" style={{ color: "var(--muted)" }}>
            What they wrote — untrusted text, shown as typed
          </div>
          <p className="whitespace-pre-wrap [overflow-wrap:anywhere] text-(length:--fs-sm)">
            {report.details}
          </p>
        </div>
      ) : (
        <p className="mt-[var(--sp-3)] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
          They picked a reason and wrote nothing else.
        </p>
      )}
    </div>
  );
}

interface AdminMessageResponse {
  message: ChatMessage & { extracted: { lines?: LineAudit[] } | null };
  loads: ChatLoad[];
}

function MessageWorkbench({
  messageId,
  onToast,
}: {
  messageId: number;
  onToast(text: string): void;
}) {
  const detail = useAdminResource<AdminMessageResponse>(`/api/admin/messages/${messageId}`);
  const [openLine, setOpenLine] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const message = detail.data?.message ?? null;
  const lines: LineAudit[] = message?.extracted?.lines ?? [];
  const scope = message?.sender_key ? `sender:${message.sender_key}` : "global";

  /**
   * One save, one server-side reprocess. The rules route already replays the
   * message and the sender's recent history and returns the count.
   */
  const saveRule = useCallback(
    async (kind: string, key: string, value: unknown) => {
      setBusy(true);
      try {
        const res = await fetch(api("/api/admin/rules"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind, scope, key, value }),
        });
        if (res.status === 404) {
          onToast("The rules endpoint is not available yet.");
          return;
        }
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          onToast(body?.error ?? "Could not save the rule");
          return;
        }
        onToast(`Rule saved. Reprocessed ${body?.reprocessed ?? 0} messages.`);
        setOpenLine(null);
        detail.reload();
      } finally {
        setBusy(false);
      }
    },
    [scope, onToast, detail],
  );

  async function confirmFormat() {
    if (!message?.format_signature) return;
    setBusy(true);
    try {
      const res = await fetch(
        api(`/api/admin/formats/${encodeURIComponent(message.format_signature)}`),
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "known" }),
        },
      );
      if (res.status === 404) {
        onToast("The formats endpoint is not available yet.");
        return;
      }
      const body = await res.json().catch(() => null);
      onToast(`Format confirmed. Reprocessed ${body?.reprocessed ?? 0} messages.`);
      detail.reload();
    } finally {
      setBusy(false);
    }
  }

  async function accept() {
    setBusy(true);
    try {
      const res = await fetch(api(`/api/admin/messages/${messageId}/accept`), { method: "POST" });
      onToast(res.ok ? "Extraction accepted as a pattern case." : "Accept is not available yet.");
    } finally {
      setBusy(false);
    }
  }

  async function reprocess() {
    setBusy(true);
    try {
      const res = await fetch(api(`/api/admin/reprocess?message=${messageId}`), { method: "POST" });
      if (res.status === 404) {
        onToast("The reprocess endpoint is not available yet.");
        return;
      }
      const body = await res.json().catch(() => null);
      onToast(`Reprocessed ${body?.reprocessed ?? 1} message(s).`);
      detail.reload();
    } finally {
      setBusy(false);
    }
  }

  if (detail.unavailable) return <Unavailable what="The message endpoint" />;
  if (detail.loading || !message) return <p style={{ color: "var(--muted)" }}>Loading message…</p>;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-[var(--sp-2)]">
        <span className="font-semibold">{message.author_name ?? "Unknown"}</span>
        {message.attention && <Chip tone="warn">{message.attention}</Chip>}
        {message.parse_status && (
          <Chip tone={message.parse_status === "clean" ? "ok" : "warn"}>{message.parse_status}</Chip>
        )}
        <button className="btn btn-sm" disabled={busy} onClick={confirmFormat}>
          Confirm format
        </button>
        <button className="btn btn-sm" disabled={busy} onClick={accept}>
          Accept extraction
        </button>
        <button className="btn btn-sm" disabled={busy} onClick={reprocess}>
          Reprocess
        </button>
      </div>

      <div className="line-gutter mt-[var(--sp-3)] flex flex-col gap-[2px]">
        {lines.length === 0 ? (
          <pre className="whitespace-pre-wrap text-(length:--fs-sm)">{message.body}</pre>
        ) : (
          lines.map((line) => (
            <div key={line.n} className={LINE_CLASS[line.class] ?? ""}>
              <button
                type="button"
                className="block w-full text-left"
                title={[line.class, line.reason, ...(line.flags ?? [])].filter(Boolean).join(" · ")}
                onClick={() => setOpenLine(openLine === line.n ? null : line.n)}
              >
                {line.text || " "}
              </button>
              {openLine === line.n && (
                <LineActions
                  text={line.text}
                  busy={busy}
                  onSaveRule={saveRule}
                  onClose={() => setOpenLine(null)}
                />
              )}
            </div>
          ))
        )}
      </div>

      <SenderFormatEditor scope={scope} busy={busy} onSaveRule={saveRule} />
    </div>
  );
}

/**
 * The per-line fixes. Each one is a rule, and each rule is the last time this
 * particular line has to be looked at.
 */
function LineActions({
  text,
  busy,
  onSaveRule,
  onClose,
}: {
  text: string;
  busy: boolean;
  onSaveRule(kind: string, key: string, value: unknown): Promise<void>;
  onClose(): void;
}) {
  const [mode, setMode] = useState<"none" | "place" | "ignore" | "word" | "teach">("none");
  const [placeText, setPlaceText] = useState(text);
  const [word, setWord] = useState(text.trim().split(/\s+/)[0] ?? "");
  const [wordAs, setWordAs] = useState<string>("CF_UNIT");
  const [template, setTemplate] = useState(text);

  return (
    <div className="card mt-[var(--sp-1)] p-[var(--sp-2)]" style={{ fontFamily: "inherit" }}>
      <div className="flex flex-wrap gap-[var(--sp-1)]">
        <button className="btn btn-sm" onClick={() => setMode("place")}>
          Resolve place
        </button>
        <button className="btn btn-sm" onClick={() => setMode("ignore")}>
          Ignore line as …
        </button>
        <button className="btn btn-sm" onClick={() => setMode("word")}>
          Add word
        </button>
        <button className="btn btn-sm" onClick={() => setMode("teach")}>
          Teach line
        </button>
        <button className="btn btn-ghost btn-sm ml-auto" onClick={onClose}>
          Close
        </button>
      </div>

      {mode === "place" && (
        <div className="mt-[var(--sp-2)]">
          <div className="label">What place is this line?</div>
          {/* The raw line text is the key; A normalizes it server-side so
              "📍 KEARNY, NJ:" and "kearny nj" land on the same rule. */}
          <LocationInput
            value={placeText}
            onChange={setPlaceText}
            onPick={(place: ResolvedPlace) => void onSaveRule("place", text, place)}
            placeholder="Kearny, NJ"
            ariaLabel="Resolve this origin"
          />
        </div>
      )}

      {mode === "ignore" && (
        <div className="mt-[var(--sp-2)] flex flex-wrap gap-[var(--sp-1)]">
          {IGNORE_AS.map((as) => (
            <button
              key={as}
              className="btn btn-sm"
              disabled={busy}
              onClick={() => void onSaveRule("ignore_line", text, { text, as })}
            >
              {as}
            </button>
          ))}
        </div>
      )}

      {mode === "word" && (
        <div className="mt-[var(--sp-2)] flex flex-wrap items-end gap-[var(--sp-2)]">
          <div>
            <div className="label">Word</div>
            <input className="field" value={word} onChange={(e) => setWord(e.target.value)} />
          </div>
          <div>
            <div className="label">Means</div>
            <input
              className="field"
              list="keyword-as"
              value={wordAs}
              onChange={(e) => setWordAs(e.target.value)}
            />
            <datalist id="keyword-as">
              {KEYWORD_AS.map((k) => (
                <option key={k} value={k} />
              ))}
              <option value="TAG:bulky" />
              <option value="CITY:Kearny, NJ" />
            </datalist>
          </div>
          <button
            className="btn btn-primary btn-sm"
            disabled={busy || !word.trim()}
            onClick={() => void onSaveRule("keyword", word, { word, as: wordAs })}
          >
            Save word
          </button>
        </div>
      )}

      {mode === "teach" && (
        <div className="mt-[var(--sp-2)]">
          <div className="label">Mark the parts</div>
          <div className="mb-[var(--sp-1)] flex flex-wrap gap-[var(--sp-1)]">
            {PLACEHOLDERS.map((p) => (
              <button
                key={p}
                className="chip chip-button"
                onClick={() => setTemplate((t) => `${t} ${p}`.trim())}
              >
                {p}
              </button>
            ))}
          </div>
          <input
            className="field font-mono"
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
          />
          <button
            className="btn btn-primary btn-sm mt-[var(--sp-2)]"
            disabled={busy || !template.trim()}
            onClick={() =>
              void onSaveRule("line_template", text, {
                id: `taught-${Date.now()}`,
                template,
                kind: "destination",
              })
            }
          >
            Save template
          </button>
        </div>
      )}
    </div>
  );
}

function SenderFormatEditor({
  scope,
  busy,
  onSaveRule,
}: {
  scope: string;
  busy: boolean;
  onSaveRule(kind: string, key: string, value: unknown): Promise<void>;
}) {
  const [priceMode, setPriceMode] = useState("");
  const [bareNumber, setBareNumber] = useState("");
  const [stateFromZip, setStateFromZip] = useState(false);

  return (
    <details className="card mt-[var(--sp-4)] p-[var(--sp-3)]">
      <summary className="cursor-pointer font-semibold">Sender format</summary>
      <div className="mt-[var(--sp-2)] flex flex-wrap items-end gap-[var(--sp-3)]">
        <div>
          <div className="label">Price mode</div>
          <select className="field" value={priceMode} onChange={(e) => setPriceMode(e.target.value)}>
            <option value="">unset</option>
            <option value="per_cf">per cf</option>
            <option value="flat">flat</option>
          </select>
        </div>
        <div>
          <div className="label">A bare number is</div>
          <select className="field" value={bareNumber} onChange={(e) => setBareNumber(e.target.value)}>
            <option value="">unset</option>
            <option value="cf">cubic feet</option>
            <option value="note">a note</option>
          </select>
        </div>
        <label className="flex items-center gap-[var(--sp-2)]">
          <input
            type="checkbox"
            checked={stateFromZip}
            onChange={(e) => setStateFromZip(e.target.checked)}
          />
          State from ZIP only
        </label>
        <button
          className="btn btn-primary btn-sm"
          disabled={busy}
          onClick={() =>
            void onSaveRule("sender_format", scope, {
              price_mode: priceMode || null,
              bare_number_is: bareNumber || null,
              state_from_zip_only: stateFromZip,
            })
          }
        >
          Save format
        </button>
      </div>
    </details>
  );
}

/* ------------------------- paste-a-message harness ------------------------ */

interface TryResult {
  status: string;
  reason?: string;
  loadsCreated: number;
  extractor: string | null;
  parse_status: string | null;
  attention: string | null;
  format_signature: string | null;
  flags: string[];
  loads: ChatLoad[];
}

function TryMessage() {
  const [text, setText] = useState(EXAMPLES[0].text);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TryResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(dryRun: boolean) {
    setBusy(true);
    setError(null);
    setResult(null);
    const res = await fetch(api("/api/admin/ingest"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, group: "Manual entry", dryRun }),
    });
    const json = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) setError(json?.error ?? "Failed");
    else setResult(json as TryResult);
  }

  return (
    <div className="grid gap-[var(--sp-4)] lg:grid-cols-2">
      <div className="card p-[var(--sp-4)]">
        <div className="label">WhatsApp message</div>
        <textarea
          className="field font-mono"
          rows={12}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="mt-[var(--sp-3)] flex flex-wrap gap-[var(--sp-1)]">
          {EXAMPLES.map((ex) => (
            <button
              key={ex.label}
              className="chip chip-button"
              onClick={() => setText(ex.text)}
            >
              {ex.label}
            </button>
          ))}
        </div>
        <div className="mt-[var(--sp-3)] flex gap-[var(--sp-2)]">
          <button className="btn" onClick={() => run(true)} disabled={busy || !text.trim()}>
            {busy ? "Extracting…" : "Preview only"}
          </button>
          <button className="btn btn-primary" onClick={() => run(false)} disabled={busy || !text.trim()}>
            Run the pipeline
          </button>
        </div>
        <p className="mt-[var(--sp-2)] text-(length:--fs-xs)" style={{ color: "var(--muted)" }}>
          Preview extracts without writing anything. Run does what webhook traffic does, and the jobs
          land on the live board.
        </p>
      </div>

      <div className="card p-[var(--sp-4)]">
        <div className="label">Result</div>
        {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
        {!result && !error && (
          <p className="text-(length:--fs-base)" style={{ color: "var(--muted)" }}>
            Run a message to see the output.
          </p>
        )}

        {result && (
          <div className="flex flex-col gap-[var(--sp-3)]">
            <div className="flex flex-wrap items-center gap-[var(--sp-1)]">
              <Chip tone={result.status === "done" ? "ok" : result.status === "error" ? "danger" : "warn"}>
                {result.status}
              </Chip>
              {result.parse_status && (
                <Chip tone={result.parse_status === "clean" ? "ok" : "warn"}>{result.parse_status}</Chip>
              )}
              {result.attention && <Chip tone="warn">{result.attention}</Chip>}
              {result.reason && <Chip tone="danger">{result.reason}</Chip>}
              {result.format_signature && (
                <Chip title="Format signature">
                  <code>{result.format_signature}</code>
                </Chip>
              )}
            </div>

            {(result.loads?.length ?? 0) === 0 ? (
              <p className="text-(length:--fs-base)" style={{ color: "var(--muted)" }}>
                No jobs produced — the correct outcome for chatter and for anything without both an
                origin and a destination.
              </p>
            ) : (
              <div className="flex flex-col gap-[var(--sp-1)]">
                {result.loads.map((l) => (
                  <div key={l.id} className="text-(length:--fs-sm)">
                    <span className="font-semibold">
                      {l.pickup_label} → {l.delivery_label}
                    </span>
                    {" · "}
                    <span className="nums">{l.cubic_feet != null ? formatCf(l.cubic_feet) : "no size"}</span>
                    {l.price_per_cf != null && <span className="nums"> · ${l.price_per_cf}/cf</span>}
                    {" · "}
                    {l.ready_now
                      ? "ready now"
                      : (l.ready_date ??
                        (l.ready_state === "not_ready" ? "not ready" : "ready date not stated"))}
                    {(l.flags?.length ?? 0) > 0 && (
                      <span style={{ color: "var(--warn)" }}> · {l.flags.join(", ")}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* -------------------------------- messages -------------------------------- */

function MessageFeed() {
  const [status, setStatus] = useState("");
  const feed = useAdminResource<{ messages: QueueMessage[] }>(
    `/api/admin/messages?${new URLSearchParams({ ...(status ? { status } : {}), limit: "100" })}`,
  );

  if (feed.unavailable) return <Unavailable what="The message feed" />;

  return (
    <div>
      <div className="flex flex-wrap gap-[var(--sp-1)]">
        {["", "pending", "done", "skipped", "error"].map((s) => (
          <FilterChip key={s || "all"} on={status === s} onClick={() => setStatus(s)}>
            {s || "all"}
          </FilterChip>
        ))}
      </div>

      <div className="mt-[var(--sp-3)] overflow-x-auto">
        <table className="w-full border-collapse text-(length:--fs-sm)">
          <thead>
            <tr className="label border-b border-border text-left">
              <th className="px-[var(--sp-2)] py-[var(--sp-2)]">Sender</th>
              <th className="px-[var(--sp-2)] py-[var(--sp-2)]">Group</th>
              <th className="px-[var(--sp-2)] py-[var(--sp-2)]">Sent</th>
              <th className="px-[var(--sp-2)] py-[var(--sp-2)]">Parse</th>
              <th className="px-[var(--sp-2)] py-[var(--sp-2)]">Attention</th>
              <th className="px-[var(--sp-2)] py-[var(--sp-2)]">Jobs</th>
            </tr>
          </thead>
          <tbody>
            {(feed.data?.messages ?? []).map((m) => (
              <tr key={m.id} className="border-b border-border">
                <td className="px-[var(--sp-2)] py-[var(--sp-2)]">{m.author_name ?? "Unknown"}</td>
                <td className="px-[var(--sp-2)] py-[var(--sp-2)]">{m.group_name ?? "—"}</td>
                <td className="px-[var(--sp-2)] py-[var(--sp-2)]">
                  {new Date(m.sent_at).toLocaleDateString()}
                </td>
                <td className="px-[var(--sp-2)] py-[var(--sp-2)]">
                  {m.parse_status ?? m.status}
                  {m.skip_reason ? `: ${m.skip_reason}` : ""}
                </td>
                <td className="px-[var(--sp-2)] py-[var(--sp-2)]">{m.attention ?? "—"}</td>
                <td className="nums px-[var(--sp-2)] py-[var(--sp-2)]">{m.load_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {feed.loading && <p style={{ color: "var(--muted)" }}>Loading…</p>}
      </div>
    </div>
  );
}

/* --------------------------------- senders -------------------------------- */

interface SenderRow {
  key: string;
  display_name: string | null;
  author_phone: string | null;
  phones: string[];
  groups: string[];
  last_snapshot_at: string | null;
  available: number;
  delisted: number;
  /** Available jobs of theirs with no number at all: what attaching one fixes. */
  unreachable_count: number;
  default_origin: { label?: string } | null;
}

/**
 * Senders, and the two things an admin can fix about one.
 *
 * The Phone column is the reachability escape hatch. A pasted chat export
 * arrives with no author id, so the sender has no number and every job of
 * theirs is a dead end; attaching one here rebuilds the sender, which copies it
 * onto all of their phone-less rows at once. In production the Cloud API
 * webhook always carries the sender's WA id, so this column is normally
 * read-only information -- the "unreachable" count next to it says when it is
 * not.
 */
function Senders({ onToast }: { onToast(text: string): void }) {
  const senders = useAdminResource<{ senders: SenderRow[] }>("/api/admin/senders");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [phoneDraft, setPhoneDraft] = useState<Record<string, string>>({});

  if (senders.unavailable) return <Unavailable what="The senders list" />;

  // A raw "+" in a path is a space to some clients, so the key is encoded.
  async function patch(key: string, body: Record<string, unknown>): Promise<string | null> {
    const res = await fetch(api(`/api/admin/senders/${encodeURIComponent(key)}`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    senders.reload();
    if (res.ok) return null;
    const err = await res.json().catch(() => null);
    return err?.error ?? "Request failed";
  }

  async function save(key: string) {
    const err = await patch(key, { default_origin: draft[key] ?? "" });
    onToast(err ?? "Default origin saved.");
  }

  async function savePhone(key: string, rebuilt: number) {
    const err = await patch(key, { author_phone: phoneDraft[key] ?? "" });
    onToast(
      err ??
        (phoneDraft[key]?.trim()
          ? `Number attached — ${rebuilt} job${rebuilt === 1 ? "" : "s"} of theirs can be revealed now.`
          : "Number detached."),
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-(length:--fs-sm)">
        <thead>
          <tr className="label border-b border-border text-left">
            <th className="px-[var(--sp-2)] py-[var(--sp-2)]">Sender</th>
            <th className="px-[var(--sp-2)] py-[var(--sp-2)]">Phones</th>
            <th className="px-[var(--sp-2)] py-[var(--sp-2)]">Attach a number</th>
            <th className="px-[var(--sp-2)] py-[var(--sp-2)]">Groups</th>
            <th className="px-[var(--sp-2)] py-[var(--sp-2)]">Last post</th>
            <th className="px-[var(--sp-2)] py-[var(--sp-2)]">Jobs</th>
            <th className="px-[var(--sp-2)] py-[var(--sp-2)]">Default origin</th>
          </tr>
        </thead>
        <tbody>
          {(senders.data?.senders ?? []).map((s) => (
            <tr key={s.key} className="border-b border-border">
              <td className="px-[var(--sp-2)] py-[var(--sp-2)]">{s.display_name ?? s.key}</td>
              <td className="nums px-[var(--sp-2)] py-[var(--sp-2)]">
                {s.phones?.length ? (
                  s.phones.join(", ")
                ) : (
                  <Chip tone="warn">
                    no number{s.unreachable_count ? ` · ${s.unreachable_count} unreachable` : ""}
                  </Chip>
                )}
              </td>
              <td className="px-[var(--sp-2)] py-[var(--sp-2)]">
                <div className="flex gap-[var(--sp-1)]">
                  <input
                    className="field"
                    inputMode="tel"
                    placeholder="+1 305 555 0142"
                    aria-label={`Phone for ${s.display_name ?? s.key}`}
                    value={phoneDraft[s.key] ?? s.author_phone ?? ""}
                    onChange={(e) => setPhoneDraft({ ...phoneDraft, [s.key]: e.target.value })}
                  />
                  <button className="btn btn-sm" onClick={() => savePhone(s.key, s.available)}>
                    Save
                  </button>
                </div>
              </td>
              <td className="px-[var(--sp-2)] py-[var(--sp-2)]">{s.groups?.join(", ") || "—"}</td>
              <td className="px-[var(--sp-2)] py-[var(--sp-2)]">
                {s.last_snapshot_at ? new Date(s.last_snapshot_at).toLocaleDateString() : "—"}
              </td>
              <td className="nums px-[var(--sp-2)] py-[var(--sp-2)]">
                {s.available} available · {s.delisted} delisted
              </td>
              <td className="px-[var(--sp-2)] py-[var(--sp-2)]">
                <div className="flex gap-[var(--sp-1)]">
                  <input
                    className="field"
                    aria-label={`Default origin for ${s.display_name ?? s.key}`}
                    value={draft[s.key] ?? s.default_origin?.label ?? ""}
                    onChange={(e) => setDraft({ ...draft, [s.key]: e.target.value })}
                  />
                  <button className="btn btn-sm" onClick={() => save(s.key)}>
                    Save
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {senders.loading && <p style={{ color: "var(--muted)" }}>Loading…</p>}
    </div>
  );
}

/* ---------------------------------- rules --------------------------------- */

interface RuleRow {
  id: number;
  kind: string;
  scope: string;
  key: string;
  value: unknown;
  note: string | null;
  active: boolean;
}

function Rules({ onToast }: { onToast(text: string): void }) {
  const rules = useAdminResource<{ rules: RuleRow[] }>("/api/admin/rules");
  if (rules.unavailable) return <Unavailable what="The rules list" />;

  async function toggle(rule: RuleRow) {
    const res = await fetch(api(`/api/admin/rules/${rule.id}`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: !rule.active }),
    });
    onToast(res.ok ? `Rule ${rule.active ? "deactivated" : "reactivated"}.` : "Could not update the rule.");
    rules.reload();
  }

  return (
    <div>
      <p className="mb-[var(--sp-2)] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
        Run <code>npm run rules:export</code> to add these to the eval fixtures, so a fix made here
        cannot regress.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-(length:--fs-sm)">
          <thead>
            <tr className="label border-b border-border text-left">
              <th className="px-[var(--sp-2)] py-[var(--sp-2)]">Kind</th>
              <th className="px-[var(--sp-2)] py-[var(--sp-2)]">Scope</th>
              <th className="px-[var(--sp-2)] py-[var(--sp-2)]">Key</th>
              <th className="px-[var(--sp-2)] py-[var(--sp-2)]">Value</th>
              <th className="px-[var(--sp-2)] py-[var(--sp-2)]">Active</th>
            </tr>
          </thead>
          <tbody>
            {(rules.data?.rules ?? []).map((r) => (
              <tr key={r.id} className="border-b border-border">
                <td className="px-[var(--sp-2)] py-[var(--sp-2)]">{r.kind}</td>
                <td className="px-[var(--sp-2)] py-[var(--sp-2)]">{r.scope}</td>
                <td className="px-[var(--sp-2)] py-[var(--sp-2)]">
                  <code>{r.key}</code>
                </td>
                <td className="px-[var(--sp-2)] py-[var(--sp-2)]" title={r.note ?? undefined}>
                  {summarizeValue(r.value)}
                </td>
                <td className="px-[var(--sp-2)] py-[var(--sp-2)]">
                  <button className="btn btn-sm" onClick={() => toggle(r)}>
                    {r.active ? "on" : "off"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rules.loading && <p style={{ color: "var(--muted)" }}>Loading…</p>}
      </div>
    </div>
  );
}

function summarizeValue(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string") return value;
  const json = JSON.stringify(value);
  return json.length > 80 ? `${json.slice(0, 77)}…` : json;
}

/* --------------------------------- groups --------------------------------- */

interface AdminGroup {
  id: number;
  invite_url: string | null;
}

/**
 * Groups, and the one WhatsApp link that can reach one.
 *
 * WhatsApp has no public link to an individual message, so a job whose post
 * carried no number can only point a driver at the group as a whole -- and a
 * group invite cannot be derived either: somebody with admin rights in that
 * group has to generate it and paste it here. Until they do, the job's contact
 * block still offers "Copy the job"; the link only adds the shortcut.
 *
 * The links come from /api/admin/groups rather than from the group list this
 * page already server-renders, because a stored link may be a `wa.me` line --
 * a phone number written as a URL -- and that must not ride along in a payload
 * anyone but an admin receives.
 */
function Groups({ groups, onToast }: { groups: ChatGroup[]; onToast(text: string): void }) {
  const links = useAdminResource<{ groups: AdminGroup[] }>("/api/admin/groups");
  const [draft, setDraft] = useState<Record<number, string>>({});

  const stored = new Map((links.data?.groups ?? []).map((g) => [g.id, g.invite_url]));

  async function save(id: number) {
    const res = await fetch(api(`/api/admin/groups/${id}`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invite_url: draft[id] ?? "" }),
    });
    const body = await res.json().catch(() => null);
    onToast(res.ok ? (body?.group?.invite_url ? "Group link saved." : "Group link removed.") : (body?.error ?? "Could not save the link."));
    links.reload();
  }

  return (
    <div>
      <p className="mb-[var(--sp-2)] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
        A group invite (<code>https://chat.whatsapp.com/…</code>) has to be generated inside WhatsApp
        by a group admin — it cannot be derived. A <code>wa.me</code> number works too, for a “group”
        that is really a dispatcher’s line. There is no link to a single message, so nothing here
        offers one.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-(length:--fs-sm)">
          <thead>
            <tr className="label border-b border-border text-left">
              <th className="px-[var(--sp-2)] py-[var(--sp-2)]">Group</th>
              <th className="px-[var(--sp-2)] py-[var(--sp-2)]">Description</th>
              <th className="px-[var(--sp-2)] py-[var(--sp-2)]">WhatsApp link</th>
              <th className="px-[var(--sp-2)] py-[var(--sp-2)]">Messages</th>
              <th className="px-[var(--sp-2)] py-[var(--sp-2)]">Jobs</th>
              <th className="px-[var(--sp-2)] py-[var(--sp-2)]">Skipped</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.id} className="border-b border-border">
                <td className="px-[var(--sp-2)] py-[var(--sp-2)] font-semibold">{g.name}</td>
                <td className="px-[var(--sp-2)] py-[var(--sp-2)]">{g.description ?? "—"}</td>
                <td className="px-[var(--sp-2)] py-[var(--sp-2)]">
                  {links.unavailable ? (
                    <span style={{ color: "var(--muted)" }}>—</span>
                  ) : (
                    <div className="flex gap-[var(--sp-1)]">
                      <input
                        className="field"
                        style={{ minWidth: "18rem" }}
                        placeholder="https://chat.whatsapp.com/…"
                        aria-label={`WhatsApp link for ${g.name}`}
                        value={draft[g.id] ?? stored.get(g.id) ?? ""}
                        onChange={(e) => setDraft({ ...draft, [g.id]: e.target.value })}
                      />
                      <button className="btn btn-sm" onClick={() => save(g.id)}>
                        Save
                      </button>
                    </div>
                  )}
                </td>
                <td className="nums px-[var(--sp-2)] py-[var(--sp-2)]">{g.message_count}</td>
                <td className="nums px-[var(--sp-2)] py-[var(--sp-2)]">{g.load_count}</td>
                <td className="nums px-[var(--sp-2)] py-[var(--sp-2)]">{g.skipped_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------ map precision ----------------------------- */

/**
 * "Every destination is a hollow approximate marker" is the most visible way
 * this board can look broken, and on a fresh deployment it is the default.
 *
 * The reason is deliberate at ingest: a job is stored the moment it is read,
 * and if the geocoder is unreachable the ZIP is placed at the nearest
 * gazetteer city inside its own state and honestly labelled `state` precision.
 * Locally `npm run zips:warm` upgrades those. In production nothing can run a
 * script against the database — it is inside the VPC — so the same sweep has
 * to be reachable from here.
 *
 * The button walks the board in batches and shows what each one did, rather
 * than posting once and spinning: a board with thousands of ZIPs would blow
 * any request timeout, and a driver-facing number ("34 jobs moved") is more
 * convincing than a spinner that eventually stops.
 */
interface GeocodeStatus {
  survey: ZipSurvey;
  here: HereStatus;
  batch: number;
}

interface WarmTotals {
  batches: number;
  examined: number;
  fetched: number;
  upgraded: number;
  unresolved: number;
  loadsUpdated: number;
  pickupsUpgraded: number;
  deliveriesUpgraded: number;
}

const NO_TOTALS: WarmTotals = {
  batches: 0, examined: 0, fetched: 0, upgraded: 0,
  unresolved: 0, loadsUpdated: 0, pickupsUpgraded: 0, deliveriesUpgraded: 0,
};

/**
 * 50 batches of 40 is 2,000 ZIPs — the same ceiling as the HERE daily budget,
 * so the loop cannot outrun the thing that pays for it even if the cursor
 * somehow failed to advance.
 */
const MAX_BATCHES = 50;

function MapPrecision({ onToast }: { onToast(text: string): void }) {
  const status = useAdminResource<GeocodeStatus>("/api/admin/geocode");
  const [busy, setBusy] = useState(false);
  const [totals, setTotals] = useState<WarmTotals>(NO_TOTALS);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const survey = status.data?.survey ?? null;
  const here = status.data?.here ?? null;

  async function run() {
    setBusy(true);
    setError(null);
    setTotals(NO_TOTALS);
    setRemaining(null);

    const sum = { ...NO_TOTALS };
    let after: string | null = null;

    try {
      for (let i = 0; i < MAX_BATCHES; i += 1) {
        const res = await fetch(api(`/api/admin/geocode${after ? `?after=${encodeURIComponent(after)}` : ""}`), {
          method: "POST",
        });
        const json = await res.json().catch(() => null);
        if (!res.ok) {
          setError(json?.error ?? "Could not reach the geocoder.");
          break;
        }
        const r = json as ZipWarmResult;
        sum.batches += 1;
        sum.examined += r.examined;
        sum.fetched += r.fetched;
        sum.upgraded += r.upgraded;
        sum.unresolved += r.unresolved;
        sum.loadsUpdated += r.loadsUpdated;
        sum.pickupsUpgraded += r.pickupsUpgraded;
        sum.deliveriesUpgraded += r.deliveriesUpgraded;
        setTotals({ ...sum });
        setRemaining(r.remaining);
        if (r.done) break;
        after = r.nextAfter;
      }
      onToast(
        sum.loadsUpdated
          ? `${sum.loadsUpdated} job${sum.loadsUpdated === 1 ? "" : "s"} moved onto a real point.`
          : "Nothing to upgrade — every job is already on the best point we can get.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
      status.reload();
    }
  }

  if (status.unavailable) return <Unavailable what="The geocoding endpoint" />;

  return (
    <div className="grid gap-[var(--sp-4)] lg:grid-cols-2">
      <div className="card p-[var(--sp-4)]">
        <div className="label">Where the board stands</div>
        {status.loading && !survey ? (
          <p className="mt-[var(--sp-2)] text-(length:--fs-base)" style={{ color: "var(--muted)" }}>
            Counting…
          </p>
        ) : survey ? (
          <>
            <dl className="mt-[var(--sp-3)] grid grid-cols-2 gap-[var(--sp-2)] text-(length:--fs-sm)">
              <Stat label="ZIPs on the board" value={survey.boardZips} />
              <Stat label="Placed by a geocoder" value={survey.precise} />
              <Stat label="In-state approximations" value={survey.approximate} />
              <Stat label="Never geocoded" value={survey.uncached} />
              <Stat label="Pickups drawn approximate" value={survey.coarsePickups} />
              <Stat label="Deliveries drawn approximate" value={survey.coarseDeliveries} />
            </dl>
            <p className="mt-[var(--sp-3)] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
              {survey.pending === 0
                ? "Nothing pending. Every ZIP has the best answer available."
                : `${survey.pending} ZIP${survey.pending === 1 ? "" : "s"} left to visit.`}
            </p>
          </>
        ) : (
          <p className="mt-[var(--sp-2)] text-(length:--fs-base)" style={{ color: "var(--danger)" }}>
            {status.error ?? "Could not read the board."}
          </p>
        )}
      </div>

      <div className="card p-[var(--sp-4)]">
        <div className="label">Make the map precise</div>
        <p className="mt-[var(--sp-2)] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
          Geocodes every ZIP the board points at, caches the answer forever, and moves the jobs that
          were sitting on a state centroid. Safe to run twice — a ZIP that already has a real answer
          is never asked about again.
        </p>

        {here && !here.configured && (
          <p
            className="mt-[var(--sp-3)] rounded-[var(--radius-sm)] px-[var(--sp-3)] py-[var(--sp-2)] text-(length:--fs-sm)"
            style={{ background: "var(--warn-soft)", color: "var(--warn)" }}
          >
            <code>HERE_API_KEY</code> is not configured on this deployment, so there is nothing
            better to fetch: every ZIP falls back to the nearest city in its own state. Add the key
            and run this again.
          </p>
        )}

        {here?.configured && (
          <p className="mt-[var(--sp-2)] text-(length:--fs-xs)" style={{ color: "var(--muted)" }}>
            HERE calls used today: <span className="nums">{here.callsToday}</span> of{" "}
            <span className="nums">{here.budget}</span>.
          </p>
        )}

        <div className="mt-[var(--sp-3)] flex items-center gap-[var(--sp-2)]">
          <button
            className="btn btn-primary"
            onClick={run}
            disabled={busy || !survey || !here?.configured}
          >
            {busy ? "Geocoding…" : "Make the map precise"}
          </button>
          {busy && remaining !== null && (
            <span className="text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
              {remaining} ZIP{remaining === 1 ? "" : "s"} to go
            </span>
          )}
        </div>

        {error && (
          <p className="mt-[var(--sp-3)] text-(length:--fs-sm)" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        )}

        {totals.batches > 0 && (
          <dl className="mt-[var(--sp-3)] grid grid-cols-2 gap-[var(--sp-2)] text-(length:--fs-sm)">
            <Stat label="ZIPs visited" value={totals.examined} />
            <Stat label="Geocoded for the first time" value={totals.fetched} />
            <Stat label="Approximations upgraded" value={totals.upgraded} />
            <Stat label="Still unresolved" value={totals.unresolved} />
            <Stat label="Pickups moved" value={totals.pickupsUpgraded} />
            <Stat label="Deliveries moved" value={totals.deliveriesUpgraded} />
            <Stat label="Jobs changed" value={totals.loadsUpdated} />
            <Stat label="Batches" value={totals.batches} />
          </dl>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt style={{ color: "var(--muted)" }}>{label}</dt>
      <dd className="nums text-(length:--fs-lg) font-semibold">{value}</dd>
    </div>
  );
}

function FilterChip({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick(): void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="chip chip-button"
      aria-pressed={on}
      onClick={onClick}
      style={{
        background: on ? "var(--accent-soft)" : "var(--surface-2)",
        color: on ? "var(--accent)" : "var(--text-2)",
      }}
    >
      {children}
    </button>
  );
}
