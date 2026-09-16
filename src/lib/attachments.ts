import type { ChatAttachment } from "./types.ts";
import type { ReviewChatContext } from "./reviewChat.ts";

export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_ATTACHMENTS = 5;
export const MAX_TOTAL_ATTACHMENT_BYTES = 12 * 1024 * 1024;

export interface AttachmentDraft extends ChatAttachment {
  id: string;
  size: number;
  reviewContext?: ReviewChatContext;
}

export function validateAttachments(
  existing: { size: number }[],
  incoming: { size: number; name: string }[],
): void {
  if (existing.length + incoming.length > MAX_ATTACHMENTS) {
    throw new Error(`Attach at most ${MAX_ATTACHMENTS} files per message.`);
  }
  for (const file of incoming) {
    if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${file.name} exceeds the 8 MiB file limit.`);
    if (file.size === 0) throw new Error(`${file.name} is empty.`);
  }
  const size = [...existing, ...incoming].reduce((sum, file) => sum + file.size, 0);
  if (size > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error("Attachments exceed the 12 MiB message limit.");
}

export async function readAttachment(file: File): Promise<AttachmentDraft> {
  validateAttachments([], [file]);
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}.`));
    reader.onabort = () => reject(new Error(`Reading ${file.name} was cancelled.`));
    reader.onload = () => {
      if (typeof reader.result !== "string" || !reader.result.includes(",")) {
        reject(new Error(`Could not encode ${file.name}.`));
        return;
      }
      resolve(reader.result.slice(reader.result.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
  return {
    id: crypto.randomUUID(),
    type: "blob",
    data,
    displayName: file.name,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
  };
}

export function attachmentPayload(drafts: AttachmentDraft[]): ChatAttachment[] {
  return drafts.map(({ type, data, displayName, mimeType }) => ({ type, data, displayName, mimeType }));
}
