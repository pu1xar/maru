// The app's toasts, as the web's toastManager (components/ui/toast.tsx) holds them: a type that picks
// the icon, a title, an optional description, and a close after 5 seconds (base-ui's default, which
// the web does not override). `loading` stays until it is closed. React Native-free; ToastHost draws them.

export type ToastType = "error" | "success" | "info" | "warning" | "loading";

export interface ToastItem {
  id: number;
  type: ToastType;
  title: string;
  description: string | null;
}

/** How long a toast stays (base-ui Toast.Provider's default timeout), ms. */
export const TOAST_TIMEOUT_MS = 5000;

let items: readonly ToastItem[] = [];
let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of [...listeners]) l();
}

export function toasts(): readonly ToastItem[] {
  return items;
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Shows a toast; returns its id for `closeToast`. */
export function addToast(t: { type: ToastType; title: string; description?: string | null }): number {
  const id = nextId++;
  items = [...items, { id, type: t.type, title: t.title, description: t.description ?? null }];
  if (t.type !== "loading") timers.set(id, setTimeout(() => closeToast(id), TOAST_TIMEOUT_MS));
  emit();
  return id;
}

export function closeToast(id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
  if (!items.some((t) => t.id === id)) return;
  items = items.filter((t) => t.id !== id);
  emit();
}
