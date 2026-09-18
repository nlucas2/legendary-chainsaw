export type MessageDelivery = "enqueue" | "immediate";
export const DELIVERY_DEFAULT_KEY = "copilot-sessions.default-delivery";

export function readDeliveryDefault(value: string | null): { value: MessageDelivery; error: string } {
  if (value === null || value === "enqueue") return { value: "enqueue", error: "" };
  if (value === "immediate") return { value, error: "" };
  return { value: "enqueue", error: "The saved message-delivery default is invalid. Using Queue while busy." };
}
