import { useCallback, useState } from "react";
import { Image } from "react-native";
import { Cpu } from "lucide-react-native";
import { SvgUri } from "react-native-svg";
import type { Model } from "../lib/types";
import { fileURL } from "../lib/api";
import { useTheme } from "../providers/AppProvider";

export function ModelIcon({
  model,
  size = 19,
}: {
  model?: Model;
  size?: number;
}) {
  const { colors } = useTheme();
  const source = model?.icon || model?.provider_icon;
  const [failed, setFailed] = useState("");
  const handleError = useCallback(() => setFailed(source ?? ""), [source]);
  if (!source || failed === source)
    return <Cpu size={size} color={colors.text} strokeWidth={1.8} />;
  const uri = fileURL(source);
  return /\.svg(?:\?|$)/i.test(uri) ? (
    <SvgUri
      key={`${uri}:${colors.text}`}
      uri={uri}
      width={size}
      height={size}
      color={colors.text}
      onError={handleError}
    />
  ) : (
    <Image
      source={{ uri }}
      style={{ width: size, height: size }}
      onError={handleError}
    />
  );
}
