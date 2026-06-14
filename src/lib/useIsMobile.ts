"use client";

import { useEffect, useState } from "react";

/**
 * Device-class detection via matchMedia (reliable, resize-aware — no UA sniffing).
 * "Mobile" = viewport < 1024px, so phones AND tablets get the mobile layout.
 * Returns `null` until mounted so SSR/first paint don't render the wrong tree
 * (callers render a neutral placeholder while null).
 */
const MOBILE_QUERY = "(max-width: 1023px)";

export function useIsMobile(): boolean | null {
  const [isMobile, setIsMobile] = useState<boolean | null>(null);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return isMobile;
}
