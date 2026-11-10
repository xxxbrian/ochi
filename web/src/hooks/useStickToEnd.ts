import { useLayoutEffect, useRef, type RefObject } from "react";

const nearEnd = (node: HTMLElement) => node.scrollHeight - node.clientHeight - node.scrollTop < 12;

// While `enabled`, keep a bounded streaming box scrolled to its newest text.
// Scrolling up detaches it; returning to the end re-attaches, so reading is never fought.
export function useStickToEnd(ref: RefObject<HTMLElement | null>, dependency: unknown, enabled: boolean) {
  const stuck = useRef(true);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !enabled) return;
    stuck.current = true;
    const onScroll = () => {
      stuck.current = nearEnd(node);
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => node.removeEventListener("scroll", onScroll);
  }, [ref, enabled]);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !enabled || !stuck.current) return;
    node.scrollTop = node.scrollHeight;
  }, [ref, dependency, enabled]);
}
