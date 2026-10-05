import { Cpu } from "lucide-react";
import { memo, useState } from "react";

export const BrandIcon = memo(function BrandIcon({
  src,
  size = 20,
}: {
  src?: string;
  size?: number;
}) {
  const [failed, setFailed] = useState("");
  if (!src || failed === src) return <Cpu size={size} aria-hidden />;
  return (
    <img
      src={src}
      width={size}
      height={size}
      className="brand-icon"
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(src)}
    />
  );
});
