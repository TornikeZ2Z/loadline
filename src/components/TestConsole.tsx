"use client";

/**
 * The WhatsApp console: the corpus as it looked in the group, next to exactly
 * what the rules made of it.
 *
 * Left the imported chats, middle the transcript, right the inspector. The
 * pairing is the point — extraction is the product's riskiest claim, and this
 * is where someone evaluating it can watch a real post turn into jobs, edit a
 * word, and watch it change. Skipped messages stay in the transcript with
 * their reason: a message that correctly produced nothing is a result, not a
 * gap.
 *
 * The line gutter is the newest part. A batch post is a header plus a stack of
 * destination lines, and the single most useful thing to see is which class the
 * rules assigned to each line — a red rule down the side of one line says more
 * than any summary.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/basePath";
import type { ChatGroup, ChatLoad, ChatMessage } from "@/lib/demo/chats";
import type { LineAudit, LineClass } from "@/lib/extract/schema";
import { formatCf, formatPrice, readyLabel } from "@/lib/loads/present";
import { Chip } from "./ui";

export interface TestConsoleProps {
  initialGroups: ChatGroup[];
  initialGroupId: number | null;
  initialMessages: ChatMessage[];
  /** ?message=<id> — open this message, in whichever group it belongs to. */
  initialMessageId?: number | null;
}

/** A line audit as the route returns it: A's shape plus the job it produced. */
type GutterLine = LineAudit & { job_id: number | null };

/** What each line class means, said in colour. */
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

const COMPOSE_PLACEHOLDER =
  "FROM KEARNY NJ:\n400cf MI 48864 RFD\n200cf FL 33180 RFD\nCall/Text Marco: (201) 555-0199";

type Note = { kind: "ok" | "warn"; text: string };

interface ProcessResultish {
  status: string;
  reason?: string;
  loadsCreated: number;
  parse_status?: string | null;
  attention?: string | null;
  rebuilt?: { available: number; delisted: number; expired: number } | null;
}

export function TestConsole({
  initialGroups,
  initialGroupId,
  initialMessages,
  initialMessageId,
}: TestConsoleProps) {
  const [groups, setGroups] = useState(initialGroups);
  const [groupId, setGroupId] = useState<number | null>(initialGroupId);
  const [messages, setMessages] = useState(initialMessages);
  const [selectedId, setSelectedId] = useState<number | null>(initialMessageId ?? null);
  const [loads, setLoads] = useState<ChatLoad[]>([]);
  const [lines, setLines] = useState<GutterLine[]>([]);
  const [hoveredJob, setHoveredJob] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [composing, setComposing] = useState(false);
  const [newText, setNewText] = useState("");
  const [newAuthor, setNewAuthor] = useState("Test sender");

  const selected = messages.find((m) => m.id === selectedId) ?? null;

  const inspect = useCallback(async (id: number) => {
    const res = await fetch(api(`/api/test/messages/${id}`));
    const json = await res.json().catch(() => null);
    setLoads(json?.loads ?? []);
    // `lines` arrives with B's route rewrite; until then the gutter is simply
    // absent rather than broken.
    setLines(json?.lines ?? []);
    if (json?.message?.body) setDraft(json.message.body as string);
  }, []);

  const openGroup = useCallback(async (id: number | null) => {
    setGroupId(id);
    setSelectedId(null);
    setLoads([]);
    setLines([]);
    const res = await fetch(api(`/api/test/messages${id ? `?groupId=${id}` : ""}`));
    const json = await res.json().catch(() => null);
    setMessages(json?.messages ?? []);
  }, []);

  const select = useCallback(
    (message: ChatMessage) => {
      setSelectedId(message.id);
      setDraft(message.body);
      setNote(null);
      void inspect(message.id);
    },
    [inspect],
  );

  // A ?message= deep link lands here from the job detail's admin link.
  useEffect(() => {
    if (initialMessageId == null) return;
    const found = initialMessages.find((m) => m.id === initialMessageId);
    if (found) setDraft(found.body);
    void inspect(initialMessageId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMessageId]);

  useEffect(() => {
    if (selectedId && !messages.some((m) => m.id === selectedId)) {
      setSelectedId(null);
      setLoads([]);
      setLines([]);
    }
  }, [messages, selectedId]);

  async function saveEdit() {
    if (!selected) return;
    setBusy("save");
    const res = await fetch(api(`/api/test/messages/${selected.id}`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: draft }),
    });
    const json = await res.json().catch(() => null);
    setBusy(null);
    if (!res.ok) {
      setNote({ kind: "warn", text: json?.error ?? "Could not save" });
      return;
    }
    setMessages(json.messages ?? []);
    setGroups(json.groups ?? []);
    setNote(describe(json.result));
    // The sender's other rows may have changed status, so re-read the message.
    void inspect(selected.id);
  }

  async function remove() {
    if (!selected || !window.confirm("Delete this message and any jobs from it?")) return;
    setBusy("delete");
    const res = await fetch(api(`/api/test/messages/${selected.id}`), { method: "DELETE" });
    const json = await res.json().catch(() => null);
    setBusy(null);
    if (res.ok) {
      setMessages(json.messages ?? []);
      setGroups(json.groups ?? []);
      setSelectedId(null);
      setLoads([]);
      setLines([]);
      setNote({ kind: "ok", text: "Message deleted." });
    }
  }

  async function send() {
    if (!newText.trim()) return;
    setBusy("send");
    const res = await fetch(api("/api/test/messages"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ groupId, text: newText, author: newAuthor }),
    });
    const json = await res.json().catch(() => null);
    setBusy(null);
    if (!res.ok) {
      setNote({ kind: "warn", text: json?.error ?? "Could not send" });
      return;
    }
    setMessages(json.messages ?? []);
    setGroups(json.groups ?? []);
    setSelectedId(json.messageId);
    setDraft(newText);
    setNewText("");
    setComposing(false);
    setNote(describe(json.result));
    if (json.messageId) void inspect(json.messageId);
  }

  async function reset() {
    if (!window.confirm("Restore the original demo messages? Edits will be lost.")) return;
    setBusy("reset");
    const res = await fetch(api("/api/test/reset"), { method: "POST" });
    const json = await res.json().catch(() => null);
    setBusy(null);
    if (res.ok) {
      setGroups(json.groups ?? []);
      setGroupId(null);
      setMessages(json.messages ?? []);
      setSelectedId(null);
      setLoads([]);
      setLines([]);
      setNote({
        kind: "ok",
        text: `Restored ${json.summary?.messages ?? 0} messages → ${json.summary?.loadsCreated ?? 0} jobs, ${
          json.summary?.skipped ?? 0
        } skipped.`,
      });
    }
  }

  return (
    <div className="flex flex-col" style={{ height: "calc(100vh - var(--header-h))" }}>
      <div
        className="flex flex-wrap items-center gap-[var(--sp-3)] border-b px-[var(--sp-4)] py-[var(--sp-2)] text-[var(--fs-sm)]"
        style={{ background: "var(--warn-soft)", borderColor: "var(--border)", color: "var(--warn)" }}
      >
        <span className="chip chip-warn">TEST MODE</span>
        <span>
          Simulated WhatsApp exports, not a live connection. Edit any message and the jobs rebuild
          from it immediately.
        </span>
        <button className="btn ml-auto" onClick={reset} disabled={busy === "reset"}>
          {busy === "reset" ? "Restoring…" : "Restore demo data"}
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* ---------------- groups ---------------- */}
        <aside className="w-[240px] shrink-0 overflow-y-auto border-r border-border bg-surface">
          <div className="label px-[var(--sp-3)] py-[var(--sp-2)]">Imported chats</div>
          <button
            onClick={() => openGroup(null)}
            className="w-full px-[var(--sp-3)] py-[var(--sp-2)] text-left text-[var(--fs-base)] hover:bg-surface-2"
            style={groupId === null ? { background: "var(--accent-soft)", color: "var(--accent)" } : undefined}
          >
            All chats
          </button>
          {groups.map((g) => (
            <button
              key={g.id}
              onClick={() => openGroup(g.id)}
              className="w-full border-t border-border px-[var(--sp-3)] py-[var(--sp-2)] text-left hover:bg-surface-2"
              style={groupId === g.id ? { background: "var(--accent-soft)" } : undefined}
            >
              <div className="text-[var(--fs-base)] font-semibold">{g.name}</div>
              <div className="text-[var(--fs-xs)]" style={{ color: "var(--muted)" }}>
                {g.message_count} messages · {g.load_count} jobs
                {g.skipped_count > 0 && ` · ${g.skipped_count} skipped`}
              </div>
            </button>
          ))}
        </aside>

        {/* ---------------- transcript ---------------- */}
        <section className="flex min-w-0 flex-1 flex-col" style={{ background: "var(--surface-3)" }}>
          <div className="flex items-center gap-[var(--sp-2)] border-b border-border bg-surface px-[var(--sp-4)] py-[var(--sp-2)]">
            <div className="text-[var(--fs-base)] font-semibold">
              {groupId ? (groups.find((g) => g.id === groupId)?.name ?? "Chat") : "All chats"}
            </div>
            <span className="text-[var(--fs-sm)]" style={{ color: "var(--muted)" }}>
              {messages.length} messages
            </span>
            <button className="btn ml-auto" onClick={() => setComposing((c) => !c)}>
              {composing ? "Cancel" : "Add message"}
            </button>
          </div>

          {composing && (
            <div className="border-b border-border bg-surface p-[var(--sp-3)]">
              <div className="mb-[var(--sp-2)] flex gap-[var(--sp-2)]">
                <input
                  className="field"
                  style={{ maxWidth: 200 }}
                  value={newAuthor}
                  onChange={(e) => setNewAuthor(e.target.value)}
                  placeholder="Sender name"
                />
                <span className="self-center text-[var(--fs-xs)]" style={{ color: "var(--muted)" }}>
                  posting to {groupId ? groups.find((g) => g.id === groupId)?.name : "Test messages"}
                </span>
              </div>
              <textarea
                className="field font-mono"
                rows={4}
                value={newText}
                onChange={(e) => setNewText(e.target.value)}
                placeholder={COMPOSE_PLACEHOLDER}
              />
              <button
                className="btn btn-primary mt-[var(--sp-2)]"
                onClick={send}
                disabled={busy === "send" || !newText.trim()}
              >
                {busy === "send" ? "Processing…" : "Send through the pipeline"}
              </button>
            </div>
          )}

          <div className="min-h-0 flex-1 space-y-[var(--sp-2)] overflow-y-auto p-[var(--sp-4)]">
            {messages.map((m) => (
              <Bubble
                key={m.id}
                message={m}
                selected={m.id === selectedId}
                showGroup={groupId === null}
                lines={m.id === selectedId ? lines : null}
                hoveredJob={hoveredJob}
                onClick={() => select(m)}
              />
            ))}
            {messages.length === 0 && (
              <p className="py-[var(--sp-8)] text-center text-[var(--fs-base)]" style={{ color: "var(--muted)" }}>
                No messages in this chat yet.
              </p>
            )}
          </div>
        </section>

        {/* ---------------- inspector ---------------- */}
        <aside className="w-[430px] shrink-0 overflow-y-auto border-l border-border bg-surface">
          {!selected ? (
            <div className="p-[var(--sp-6)] text-[var(--fs-base)]" style={{ color: "var(--muted)" }}>
              Pick a message to see what the rules made of it, and to edit it.
            </div>
          ) : (
            <div className="flex flex-col gap-[var(--sp-4)] p-[var(--sp-4)]">
              <div>
                <div className="label">Message text</div>
                <textarea
                  className="field font-mono"
                  rows={6}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <div className="mt-[var(--sp-2)] flex gap-[var(--sp-2)]">
                  <button
                    className="btn btn-primary"
                    onClick={saveEdit}
                    disabled={busy === "save" || draft === selected.body || !draft.trim()}
                  >
                    {busy === "save" ? "Re-extracting…" : "Save & re-extract"}
                  </button>
                  <button
                    className="btn"
                    onClick={() => setDraft(selected.body)}
                    disabled={draft === selected.body}
                  >
                    Revert
                  </button>
                  <button className="btn ml-auto" onClick={remove} disabled={busy === "delete"}>
                    Delete
                  </button>
                </div>
                {note && (
                  <p
                    className="mt-[var(--sp-2)] rounded-[var(--radius-sm)] px-[var(--sp-2)] py-[var(--sp-1)] text-[var(--fs-sm)]"
                    style={
                      note.kind === "ok"
                        ? { background: "var(--ok-soft)", color: "var(--ok)" }
                        : { background: "var(--warn-soft)", color: "var(--warn)" }
                    }
                  >
                    {note.text}
                  </p>
                )}
              </div>

              <div className="border-t border-border pt-[var(--sp-3)]">
                <div className="mb-[var(--sp-2)] flex flex-wrap items-center gap-[var(--sp-1)]">
                  <span className="label mb-0">Extracted</span>
                  <ParseChip status={selected.parse_status} />
                  {selected.attention && <Chip tone="warn">{selected.attention}</Chip>}
                  {selected.skip_reason && <Chip tone="danger">{selected.skip_reason}</Chip>}
                  {selected.snapshot_kind && <Chip>{selected.snapshot_kind}</Chip>}
                  {selected.format_signature && (
                    <Chip title="Format signature">
                      <code>{selected.format_signature}</code>
                    </Chip>
                  )}
                </div>

                {loads.length === 0 ? (
                  <p className="text-[var(--fs-sm)]" style={{ color: "var(--muted)" }}>
                    No jobs from this message. For chatter, status replies and driver-availability
                    posts that is the correct outcome — keeping them off the board is half the job.
                  </p>
                ) : (
                  <div className="flex flex-col gap-[var(--sp-2)]">
                    {loads.map((l) => (
                      <JobRow
                        key={l.id}
                        job={l}
                        highlighted={hoveredJob === l.id}
                        onHover={setHoveredJob}
                      />
                    ))}
                  </div>
                )}
              </div>

              <div className="border-t border-border pt-[var(--sp-3)] text-[var(--fs-xs)]" style={{ color: "var(--muted)" }}>
                Sent {new Date(selected.sent_at).toLocaleString()} by{" "}
                {selected.author_name ?? "unknown"}
                {selected.group_name ? ` in ${selected.group_name}` : ""}.
                {selected.sender_key && ` Sender ${selected.sender_key}.`}
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function ParseChip({ status }: { status: string | null }) {
  if (!status) return null;
  const tone = status === "clean" ? "ok" : status === "partial" ? "warn" : "danger";
  return <Chip tone={tone}>{status}</Chip>;
}

function Bubble({
  message,
  selected,
  showGroup,
  lines,
  hoveredJob,
  onClick,
}: {
  message: ChatMessage;
  selected: boolean;
  showGroup: boolean;
  lines: GutterLine[] | null;
  hoveredJob: number | null;
  onClick(): void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className="block w-full max-w-[620px] cursor-pointer rounded-[var(--radius-md)] px-[var(--sp-3)] py-[var(--sp-2)] text-left"
      style={{
        background: "var(--surface)",
        borderLeft: `3px solid ${message.load_count > 0 ? "var(--ok)" : "var(--border-strong)"}`,
        boxShadow: selected ? "0 0 0 2px var(--accent)" : "var(--shadow-1)",
      }}
    >
      <div className="flex items-baseline gap-[var(--sp-2)]">
        <span className="text-[var(--fs-sm)] font-semibold" style={{ color: "var(--accent)" }}>
          {message.author_name ?? "Unknown"}
        </span>
        {showGroup && message.group_name && (
          <span className="text-[var(--fs-xs)]" style={{ color: "var(--muted)" }}>
            {message.group_name}
          </span>
        )}
        <span className="ml-auto text-[var(--fs-xs)]" style={{ color: "var(--muted)" }}>
          {new Date(message.sent_at).toLocaleString([], {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      </div>

      {selected && lines && lines.length > 0 ? (
        <div className="line-gutter mt-[var(--sp-2)] flex flex-col gap-[1px]">
          {lines.map((line) => (
            <div
              key={line.n}
              className={`${LINE_CLASS[line.class] ?? ""}${
                hoveredJob != null && line.job_id === hoveredJob ? " l-hit" : ""
              }`}
              title={[line.class, line.reason, ...(line.flags ?? [])].filter(Boolean).join(" · ")}
            >
              {line.text || " "}
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-[var(--sp-1)] whitespace-pre-wrap text-[var(--fs-base)]">{message.body}</p>
      )}

      <div className="mt-[var(--sp-2)] flex flex-wrap items-center gap-[var(--sp-1)]">
        <ParseChip status={message.parse_status} />
        {message.attention && <Chip tone="warn">{message.attention}</Chip>}
        {message.skip_reason && <Chip tone="danger">{message.skip_reason}</Chip>}
        <Chip tone={message.load_count > 0 ? "ok" : "muted"}>
          {message.load_count} job{message.load_count === 1 ? "" : "s"}
        </Chip>
      </div>
    </div>
  );
}

function JobRow({
  job,
  highlighted,
  onHover,
}: {
  job: ChatLoad;
  highlighted: boolean;
  onHover(id: number | null): void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const ready = readyLabel(
    { ready_now: job.ready_now, ready_date: job.ready_date, ready_source: null },
    today,
  );
  const price = formatPrice({
    price_per_cf: job.price_per_cf,
    price_flat: job.price_flat,
    cubic_feet: job.cubic_feet,
  });

  return (
    <div
      className="card p-[var(--sp-2)]"
      style={{
        background: highlighted ? "var(--accent-soft)" : "var(--surface-2)",
      }}
      onMouseEnter={() => onHover(job.id)}
      onMouseLeave={() => onHover(null)}
    >
      <div className="flex flex-wrap items-center gap-[var(--sp-2)]">
        <span className="text-[var(--fs-base)] font-semibold">
          {job.pickup_label} → {job.delivery_label}
        </span>
        <span className="nums">{job.cubic_feet != null ? formatCf(job.cubic_feet) : "no size"}</span>
        <Chip tone={ready.tone}>{ready.text}</Chip>
        <span className="nums" style={{ color: price.tone === "muted" ? "var(--muted)" : "var(--ok)" }}>
          {price.headline}
        </span>
        {job.status !== "available" && <Chip tone="muted">{job.status}</Chip>}
        {job.needs_review && (
          <Chip tone="review" title={job.flags?.join(" · ") || undefined}>
            Unverified
          </Chip>
        )}
      </div>

      {job.line_text && (
        <div
          className="mt-[var(--sp-1)] rounded-[var(--radius-sm)] px-[var(--sp-2)] py-[2px] text-[var(--fs-sm)]"
          style={{
            background: "var(--surface-3)",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          }}
        >
          line {job.line_no ?? "?"}: “{job.line_text}”
        </div>
      )}

      <div
        className="mt-[var(--sp-1)] flex flex-wrap gap-[var(--sp-2)] text-[var(--fs-xs)]"
        style={{ color: "var(--muted)" }}
      >
        <span>
          {job.pickup_precision ?? "?"} → {job.delivery_precision ?? "?"}
        </span>
        <span className="nums">confidence {job.confidence.toFixed(2)}</span>
        {job.last_seen_at && (
          <span>last seen {new Date(job.last_seen_at).toLocaleDateString()}</span>
        )}
        {job.seen_count > 1 && <span>seen {job.seen_count}×</span>}
      </div>

      <Link
        href={`/jobs/${job.id}`}
        className="mt-[var(--sp-1)] inline-block text-[var(--fs-sm)] font-semibold"
        style={{ color: "var(--accent)" }}
      >
        See it on the board →
      </Link>
    </div>
  );
}

/** What just happened, in the vocabulary the pipeline actually uses. */
function describe(result: ProcessResultish | null | undefined): Note {
  if (!result) return { kind: "warn", text: "No result returned." };
  const rebuilt = result.rebuilt
    ? ` Sender rebuilt: ${result.rebuilt.delisted} delisted, ${result.rebuilt.available} available, ${result.rebuilt.expired} expired.`
    : "";

  if (result.status === "done") {
    const jobs = result.loadsCreated;
    const attention = result.attention ? ` · sent to the attention queue as ${result.attention}` : "";
    return {
      kind: result.attention ? "warn" : "ok",
      text: `Extracted ${jobs} job${jobs === 1 ? "" : "s"}${attention}.${rebuilt}`,
    };
  }
  if (result.status === "skipped") {
    return {
      kind: "warn",
      text: `No job — ${result.reason ?? "skipped"} · sent to the attention queue.${rebuilt}`,
    };
  }
  return { kind: "warn", text: `${result.reason ?? "Extraction failed."}${rebuilt}` };
}
