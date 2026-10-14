import { useLocalSearchParams } from "expo-router";
import { TaskScreen } from "../../src/screens/TasksScreen";
export default function TaskRoute() {
  const { taskId } = useLocalSearchParams<{ taskId: string }>();
  return <TaskScreen taskId={taskId} />;
}
