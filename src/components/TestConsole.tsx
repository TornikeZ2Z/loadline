"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { ChatGroup, ChatLoad, ChatMessage } from "@/lib/demo/chats";
import { Chip } from "./ui";
import { api } from "@/lib/basePath";

/**
 * The WhatsApp test console.
 *
 * Left: the imported groups. Middle: the chat as it looked in WhatsApp. Right:
 * exactly what the pipeline made of the selected message, with the message text
 * editable so you can change the wording and watch the extracted load change.
 *
 * The point is to make extraction legible to someone evaluating the product
 * rather than reading the source -- and to make its failures legible too, which
 * is why skipped messages stay visible in the transcript with their reason.
 */
export function TestConsole({
  initialGroups,
  initialGroupId,
  initialMessages,
}: {
  initialGroups: ChatGroup[];
  initialGroupId: number | null;
  initialMessages: ChatMessage[];
}) {
  const [groups, setGroups] = useState(initialGroups);
  const [groupId, setGroupId] = useState<number | null>(initialGroupId);
  const [messages, setMessages] = useState(initialMessages);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loads, setLoads] = useState<ChatLoad[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);
  const [composing, setComposing] = useState(false);
  const [newText, setNewText] = useState("");
  const [newAuthor, setNewAuthor] = useState("Test Dispatcher");

  const selected = messages.find((m) => m.id === selectedId) ?? null;

  const openGroup = useCallback(async (id: number | null) => {
    setGroupId(id);
    setSelectedId(null);
    setLoads([]);
    const res = await fetch(api(`/api/test/messages${id ? `?groupId=${id}` : ""}`));
    const json = await res.json();
    setMessages(json.messages ?? []);
  }, []);

  const select = useCallback(async (message: ChatMessage) => {
    setSelectedId(message.id);
    setDraft(message.body);
    setNote(null);
    const res = await fetch(api(`/api/test/messages/${message.id}`));
    const json = await res.json();
    setLoads(json.loads ?? []);
  }, []);

  // Keep the inspector in step when the transcript reloads under it.
  useEffect(() => {
    if (selectedId && !messages.some((m) => m.id === selectedId)) {
      setSelectedId(null);
      setLoads([]);
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
    const json = await res.json();
    setBusy(null);

    if (!res.ok) {
      setNote({ kind: "warn", text: json.error ?? "Could not save" });
      return;
    }
    setMessages(json.messages ?? []);
    setGroups(json.groups ?? []);
    setLoads(json.loads ?? []);
    setNote(describe(json.result));
  }

  async function remove() {
    if (!selected || !window.confirm("Delete this message and any loads from it?")) return;
    setBusy("delete");
    const res = await fetch(api(`/api/test/messages/${selected.id}`), { method: "DELETE" });
    const json = await res.json();
    setBusy(null);
    if (res.ok) {
      setMessages(json.messages ?? []);
      setGroups(json.groups ?? []);
      setSelectedId(null);
      setLoads([]);
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
    const json = await res.json();
    setBusy(null);
    if (!res.ok) {
      setNote({ kind: "warn", text: json.error ?? "Could not send" });
      return;
    }
    setMessages(json.messages ?? []);
    setGroups(json.groups ?? []);
    setLoads(json.loads ?? []);
    setSelectedId(json.messageId);
    setDraft(newText);
    setNewText("");
    setComposing(false);
    setNote(describe(json.result));
  }

  async function reset() {
    if (!window.confirm("Restore the original demo messages? Edits will be lost.")) return;
    setBusy("reset");
    const res = await fetch(api("/api/test/reset"), { method: "POST" });
    const json = await res.json();
    setBusy(null);
    if (res.ok) {
      setGroups(json.groups ?? []);
      setGroupId(null);
      setMessages(json.messages ?? []);
      setSelectedId(null);
      setLoads([]);
      setNote({
        kind: "ok",
        text: `Restored ${json.summary.messages} messages → ${json.summary.loadsCreated} loads, ${json.summary.skipped} skipped, ${json.summary.duplicates} duplicates, ${json.summary.expired} expired.`,
      });
    }
  }

  return (
    <div className="flex h-[calc(100vh-49px)] flex-col">
      <div
        className="flex flex-wrap items-center gap-3 border-b px-4 py-2 text-[12px]"
        style={{ background: "var(--warn-soft)", borderColor: "var(--border)", color: "var(--warn)" }}
      >
        <span className="chip" style={{ background: "var(--warn)", color: "#fff" }}>
          TEST MODE
        </span>
        <span>
          These are simulated WhatsApp exports, not a live connection. Edit any message and the
          load rebuilds from it immediately.
        </span>
        <button className="btn ml-auto" onClick={reset} disabled={busy === "reset"}>
          {busy === "reset" ? "Restoring…" : "Restore demo data"}
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* ---------------- groups ---------------- */}
        <aside className="w-[240px] shrink-0 overflow-y-auto border-r border-border bg-surface">
          <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
            Imported chats
          </div>
          <button
            onClick={() => openGroup(null)}
            className="w-full px-3 py-2 text-left text-[13px] hover:bg-surface-2"
            style={groupId === null ? { background: "var(--accent-soft)", color: "var(--accent)" } : undefined}
          >
            All chats
          </button>
          {groups.map((g) => (
            <button
              key={g.id}
              onClick={() => openGroup(g.id)}
              className="w-full border-t border-border px-3 py-2.5 text-left hover:bg-surface-2"
              style={groupId === g.id ? { background: "var(--accent-soft)" } : undefined}
            >
              <div className="text-[13px] font-semibold">{g.name}</div>
              <div className="mt-0.5 text-[11px] text-muted">
                {g.message_count} messages · {g.load_count} loads
                {g.skipped_count > 0 && ` · ${g.skipped_count} skipped`}
              </div>
            </button>
          ))}
        </aside>

        {/* ---------------- transcript ---------------- */}
        <section className="flex min-w-0 flex-1 flex-col" style={{ background: "#eae6df" }}>
          <div className="flex items-center gap-2 border-b border-border bg-surface px-4 py-2">
            <div className="text-[13px] font-semibold">
              {groupId ? groups.find((g) => g.id === groupId)?.name : "All chats"}
            </div>
            <span className="text-[12px] text-muted">{messages.length} messages</span>
            <button className="btn ml-auto" onClick={() => setComposing((c) => !c)}>
              {composing ? "Cancel" : "Add message"}
            </button>
          </div>

          {composing && (
            <div className="border-b border-border bg-surface p-3">
              <div className="mb-2 flex gap-2">
                <input
                  className="field"
                  style={{ maxWidth: 200 }}
                  value={newAuthor}
                  onChange={(e) => setNewAuthor(e.target.value)}
                  placeholder="Sender name"
                />
                <span className="self-center text-[11px] text-muted">
                  posting to {groupId ? groups.find((g) => g.id === groupId)?.name : "Test messages"}
                </span>
              </div>
              <textarea
                className="field font-mono"
                rows={3}
                value={newText}
                onChange={(e) => setNewText(e.target.value)}
                placeholder="newark nj -> miami fl tomorrow, 18 pallets, 42k lbs, reefer, call sam 973-555-0000"
              />
              <button
                className="btn btn-primary mt-2"
                onClick={send}
                disabled={busy === "send" || !newText.trim()}
              >
                {busy === "send" ? "Processing…" : "Send through the pipeline"}
              </button>
            </div>
          )}

          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
            {messages.map((m) => (
              <Bubble
                key={m.id}
                message={m}
                selected={m.id === selectedId}
                showGroup={groupId === null}
                onClick={() => select(m)}
              />
            ))}
            {messages.length === 0 && (
              <p className="py-10 text-center text-[13px] text-muted">
                No messages in this chat yet.
              </p>
            )}
          </div>
        </section>

        {/* ---------------- inspector ---------------- */}
        <aside className="w-[430px] shrink-0 overflow-y-auto border-l border-border bg-surface">
          {!selected ? (
            <div className="p-6 text-[13px] text-muted">
              Pick a message to see what the pipeline extracted from it, and to edit it.
            </div>
          ) : (
            <div className="space-y-4 p-4">
              <div>
                <div className="label">Message text</div>
                <textarea
                  className="field font-mono"
                  rows={5}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <div className="mt-2 flex gap-2">
                  <button
                    className="btn btn-primary"
                    onClick={saveEdit}
                    disabled={busy === "save" || draft === selected.body || !draft.trim()}
                  >
                    {busy === "save" ? "Re-extracting…" : "Save & re-extract"}
                  </button>
                  <button className="btn" onClick={() => setDraft(selected.body)} disabled={draft === selected.body}>
                    Revert
                  </button>
                  <button className="btn ml-auto" onClick={remove} disabled={busy === "delete"}>
                    Delete
                  </button>
                </div>
                {note && (
                  <p
                    className="mt-2 rounded-md px-2.5 py-1.5 text-[12px]"
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

              <div className="border-t border-border pt-3">
                <div className="mb-1 flex items-center gap-2">
                  <span className="label mb-0">Extracted</span>
                  <Chip tone={selected.status === "done" ? "ok" : selected.status === "error" ? "warn" : "neutral"}>
                    {selected.status}
                  </Chip>
                  {selected.skip_reason && <Chip tone="warn">{selected.skip_reason}</Chip>}
                  {selected.extractor && <Chip>{selected.extractor}</Chip>}
                </div>

                {loads.length === 0 ? (
                  <p className="text-[12px] text-muted">
                    No loads from this message. For chatter, status replies and driver
                    availability posts that is the correct outcome — keeping them off the board is
                    half the job.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {loads.map((l) => (
                      <LoadCard key={l.id} load={l} />
                    ))}
                  </div>
                )}
              </div>

              <div className="border-t border-border pt-3 text-[11px] text-muted">
                Sent {new Date(selected.sent_at).toLocaleString()} by{" "}
                {selected.author_name ?? "unknown"}
                {selected.author_phone ? ` (${selected.author_phone})` : ""}
                {selected.group_name ? ` in ${selected.group_name}` : ""}.
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function Bubble({
  message,
  selected,
  showGroup,
  onClick,
}: {
  message: ChatMessage;
  selected: boolean;
  showGroup: boolean;
  onClick: () => void;
}) {
  const produced = message.load_count > 0;
  return (
    <button
      onClick={onClick}
      className="block w-full max-w-[620px] rounded-lg px-3 py-2 text-left shadow-sm transition-shadow"
      style={{
        background: "#fff",
        borderLeft: `3px solid ${produced ? "var(--ok)" : "var(--border-strong)"}`,
        boxShadow: selected ? "0 0 0 2px var(--accent)" : undefined,
      }}
    >
      <div className="flex items-baseline gap-2">
        <span className="text-[12px] font-semibold" style={{ color: "var(--accent)" }}>
          {message.author_name ?? "Unknown"}
        </span>
        {showGroup && message.group_name && (
          <span className="text-[11px] text-muted">{message.group_name}</span>
        )}
        <span className="ml-auto text-[11px] text-muted">
          {new Date(message.sent_at).toLocaleString([], {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      </div>

      <p className="mt-1 whitespace-pre-wrap text-[13px]">{message.body}</p>

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {produced ? (
          <Chip tone="ok">
            {message.load_count} load{message.load_count === 1 ? "" : "s"}
          </Chip>
        ) : (
          <Chip tone={message.status === "error" ? "warn" : "neutral"}>
            {message.skip_reason ?? message.status}
          </Chip>
        )}
      </div>
    </button>
  );
}

function LoadCard({ load }: { load: ChatLoad }) {
  const facts = [
    load.load_type,
    load.weight_lbs && `${load.weight_lbs.toLocaleString()} lbs`,
    load.pallets && `${load.pallets} pallets`,
    load.pieces && `${load.pieces} pcs`,
    load.rate_usd != null && `$${load.rate_usd.toLocaleString()}`,
    load.trip_miles != null && `${Math.round(load.trip_miles)} mi trip`,
  ].filter(Boolean) as string[];

  return (
    <div className="card p-2.5" style={{ background: "var(--surface-2)" }}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold">
          {load.pickup_label} → {load.delivery_label}
        </span>
        {!load.is_canonical && <Chip tone="warn">duplicate</Chip>}
        {load.needs_review && <Chip tone="warn">needs review</Chip>}
        {load.status !== "available" && <Chip>{load.status}</Chip>}
      </div>

      <dl className="mt-1.5 grid grid-cols-[92px_1fr] gap-x-3 gap-y-0.5 text-[12px]">
        <Row k="Pickup date" v={load.pickup_date ?? "not stated"} />
        {load.pickup_time && <Row k="Pickup time" v={load.pickup_time.slice(0, 5)} />}
        {load.delivery_date && <Row k="Delivery" v={load.delivery_date} />}
        {facts.length > 0 && <Row k="Freight" v={facts.join(" · ")} />}
        <Row
          k="Contact"
          v={[load.contact_name, load.contact_phone].filter(Boolean).join(" · ") || "not stated"}
        />
        <Row
          k="Precision"
          v={`${load.pickup_precision ?? "?"} → ${load.delivery_precision ?? "?"}`}
        />
        <Row k="Confidence" v={load.confidence.toFixed(2)} />
      </dl>

      <Link
        href={`/loads?q=${encodeURIComponent(load.pickup_label)}`}
        className="mt-2 inline-block text-[12px] font-semibold"
        style={{ color: "var(--accent)" }}
      >
        See it on the board →
      </Link>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-muted">{k}</dt>
      <dd className="nums">{v}</dd>
    </>
  );
}

function describe(result: {
  status: string;
  reason?: string;
  loadsCreated: number;
  duplicates: number;
}): { kind: "ok" | "warn"; text: string } {
  if (result.status === "done") {
    return {
      kind: "ok",
      text:
        `Extracted ${result.loadsCreated} load${result.loadsCreated === 1 ? "" : "s"}` +
        (result.duplicates ? `, ${result.duplicates} matched an existing post` : "") +
        ".",
    };
  }
  if (result.status === "skipped") {
    return { kind: "warn", text: `No load extracted — ${result.reason ?? "skipped"}.` };
  }
  return { kind: "warn", text: result.reason ?? "Extraction failed." };
}
