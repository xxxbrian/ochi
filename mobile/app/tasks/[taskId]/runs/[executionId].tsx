import { useLocalSearchParams } from "expo-router";
import { TaskExecutionScreen } from "../../../../src/screens/TasksScreen";
export default function ExecutionRoute() {
  const { taskId, executionId } = useLocalSearchParams<{
    taskId: string;
    executionId: string;
  }>();
  return <TaskExecutionScreen taskId={taskId} executionId={executionId} />;
}
