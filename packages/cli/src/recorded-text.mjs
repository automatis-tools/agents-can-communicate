import { shellQuote } from "@agents-can-communicate/adapter-sdk";
import { describeNativeReason } from "@agents-can-communicate/installer";

export function recordedText(message, delivery) {
  const diagnostics = delivery.map(item => item.outcome === "offered"
    ? `live offered to ${item.recipientParticipantId} via ${item.transport}`
    : item.outcome === "woken" && item.pendingApproval === true
      ? `sent a wake to ${item.recipientParticipantId} via ${item.transport}, which its session holds `
        + "for approval because it bypasses permission prompts; the message arrives with its next turn"
    : item.outcome === "woken"
      ? `woke ${item.recipientParticipantId} via ${item.transport}; the message arrives with its next turn`
    : item.outcome === "queued"
      ? item.errorCode === "transport_permission_denied"
        ? "live offer blocked by sender permissions; message remains queued; retry the same command "
          + "through approved execution"
          + (typeof message.clientMessageId === "string"
            ? ` with --client-message-id ${shellQuote(message.clientMessageId)}` : " with its original retry key")
        : item.errorCode === "no_live_transport"
          ? `${item.recipientParticipantId} has no live transport`
            + `${item.nativeReasonCode ? ` (${describeNativeReason(item.nativeReasonCode,
              { launchOption: item.nativeLaunchOption })})` : ""}`
            + "; the message waits in its inbox"
        : item.errorCode === "recipient_offline" && item.endReason === "clear"
          ? `${item.recipientParticipantId}'s conversation was cleared (/clear); the message waits `
            + "until that conversation resumes"
        : item.errorCode === "recipient_offline"
          ? `${item.recipientParticipantId} has no open session; the message waits until it starts `
            + "or resumes one"
          : `live offer unavailable (${item.errorCode ?? "durable_fallback"})`
      : `delivery already ${item.outcome}`);
  return [`recorded ${message.messageId}`, ...diagnostics].join("; ");
}
