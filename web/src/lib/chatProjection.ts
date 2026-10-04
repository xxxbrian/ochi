import type { Message, Snapshot } from "./types";

export function chatMessageKey(message: Message) {
  return message.role === "assistant" && message.run_id ? `assistant-${message.run_id}` : message.id;
}

export function projectChatMessages(messages: Message[], snapshot: Snapshot | null): Message[] {
  if (!snapshot || messages.some((message) => message.role === "assistant" && message.run_id === snapshot.run_id)) return messages;
  return [...messages, {
    id: `run-${snapshot.run_id}`,
    run_id: snapshot.run_id,
    run_status: snapshot.status,
    role: "assistant",
    content: snapshot.output,
    attachments: snapshot.artifacts,
    model_id: snapshot.model_id,
    model_name: snapshot.model_name,
    effort: snapshot.effort,
    created_at: "",
  }];
}
