import { RepoWorkbench } from "../components/repo-workbench";

const defaultApiBaseUrl =
  process.env.NEXT_PUBLIC_REPO_AGENT_API_URL ?? "http://localhost:8788";

export default function HomePage() {
  return <RepoWorkbench apiBaseUrl={defaultApiBaseUrl} />;
}
