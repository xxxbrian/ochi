import { useLocalSearchParams } from "expo-router";
import { ProjectScreen } from "../../src/screens/ProjectsScreen";
export default function ProjectRoute() {
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  return <ProjectScreen projectId={projectId} />;
}
