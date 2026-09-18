import { useEffect, useState } from "react";
import { DELIVERY_DEFAULT_KEY, readDeliveryDefault, type MessageDelivery } from "./deliveryPreference";

export function useDeliveryDefault() {
  const [saved, setSaved] = useState<{ value: MessageDelivery; error: string }>(() => {
    try { return readDeliveryDefault(localStorage.getItem(DELIVERY_DEFAULT_KEY)); }
    catch (cause) { return { value: "enqueue", error: `Could not read message defaults: ${String(cause)}` }; }
  });
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== null && event.key !== DELIVERY_DEFAULT_KEY) return;
      try {
        if (event.storageArea === localStorage) setSaved(readDeliveryDefault(event.newValue));
      } catch (cause) { setSaved((current) => ({ ...current, error: `Could not sync message defaults: ${String(cause)}` })); }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  return {
    ...saved,
    setValue(value: MessageDelivery) {
      try {
        localStorage.setItem(DELIVERY_DEFAULT_KEY, value);
        setSaved({ value, error: "" });
      } catch (cause) {
        setSaved({ value, error: `Could not save message defaults: ${String(cause)}. Change applies only to this window.` });
      }
    },
  };
}
