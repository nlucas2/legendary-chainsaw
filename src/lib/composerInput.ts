export interface ComposerKey {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
}

export function submitsComposer(key: ComposerKey, mobile: boolean): boolean {
  return key.key === "Enter" && !key.shiftKey && !key.isComposing
    && (!mobile || key.ctrlKey || key.metaKey);
}
