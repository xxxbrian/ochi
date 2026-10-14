import { useLocalSearchParams } from "expo-router";
import { ChatScreen } from "../../src/screens/ChatScreen";
export default function ChatRoute() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  return <ChatScreen sessionId={sessionId === "new" ? undefined : sessionId} />;
}
